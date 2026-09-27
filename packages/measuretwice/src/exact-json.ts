// SPDX-License-Identifier: Apache-2.0
/**
 * Exact parsing of the strict JSON text that the core produces.
 *
 * The core states projected inputs and dataset records as strict JSON text,
 * and the wrapper turns that text back into values. `JSON.parse` loses two
 * properties that the boundary promises: it rounds one integer above the
 * safe JavaScript range to one double, and it accepts the text without
 * stating how keys become properties. This parser keeps both: one integer
 * literal beyond the safe range parses as one `BigInt`, exactly as the
 * native value conversion did, and every object key is defined as one own
 * data property, so one key that assignment would redirect, such as
 * `__proto__`, arrives as the data the core validated.
 *
 * The parser accepts the strict JSON grammar only: no trailing text, no
 * comments, no single quotes. It exists for text that the core itself
 * produced, so one parse failure names one internal inconsistency of the
 * boundary rather than one authoring error.
 */

/** The greatest nesting depth the parser walks. */
const MAX_DEPTH = 512;

/** One read position over the text. */
class Cursor {
  private index = 0;
  constructor(private readonly text: string) {}

  /** Returns the character at the position, or the end of the text. */
  peek(): string {
    return this.text[this.index] ?? "";
  }

  /** Consumes one character when it matches, and states whether it did. */
  eat(character: string): boolean {
    if (this.peek() === character) {
      this.index += 1;
      return true;
    }
    return false;
  }

  /** Skips the whitespace that the strict grammar allows. */
  whitespace(): void {
    for (;;) {
      const character = this.peek();
      if (character !== " " && character !== "\t" && character !== "\r" && character !== "\n") {
        return;
      }
      this.index += 1;
    }
  }

  /** States whether the whole text was consumed. */
  atEnd(): boolean {
    return this.index >= this.text.length;
  }

  /** Reads while the characters satisfy one predicate. */
  readWhile(predicate: (character: string) => boolean): string {
    let result = "";
    while (this.index < this.text.length && predicate(this.text[this.index]!)) {
      result += this.text[this.index]!;
      this.index += 1;
    }
    return result;
  }

  /** Fails with one message that names the position. */
  fail(reason: string): never {
    throw new Error(`strict JSON: ${reason} at position ${this.index}.`);
  }
}

/**
 * Parses one strict JSON document with exact integers.
 *
 * @throws one `Error` when the text breaks the strict JSON grammar. The
 * callers treat one failure as one internal inconsistency of the boundary,
 * because the core produced the text from one validated value.
 */
export function parseExactJson(text: string): unknown {
  const cursor = new Cursor(text);
  const value = parseValue(cursor, 0);
  cursor.whitespace();
  if (!cursor.atEnd()) {
    cursor.fail("trailing text after the document");
  }
  return value;
}

/** Parses one value at the cursor. */
function parseValue(cursor: Cursor, depth: number): unknown {
  cursor.whitespace();
  if (depth >= MAX_DEPTH) {
    cursor.fail("the document nests past the depth the parser walks");
  }
  const character = cursor.peek();
  if (character === "{") {
    return parseObject(cursor, depth);
  }
  if (character === "[") {
    return parseArray(cursor, depth);
  }
  if (character === '"') {
    return parseString(cursor);
  }
  if (character === "t") {
    return parseWord(cursor, "true", true);
  }
  if (character === "f") {
    return parseWord(cursor, "false", false);
  }
  if (character === "n") {
    return parseWord(cursor, "null", null);
  }
  if (character === "-" || (character >= "0" && character <= "9")) {
    return parseNumber(cursor);
  }
  cursor.fail(`unexpected character ${JSON.stringify(character)}`);
}

/** Parses one object, defining every key as one own data property. */
function parseObject(cursor: Cursor, depth: number): Record<string, unknown> {
  cursor.eat("{");
  const result: Record<string, unknown> = {};
  cursor.whitespace();
  if (cursor.eat("}")) {
    return result;
  }
  for (;;) {
    cursor.whitespace();
    if (cursor.peek() !== '"') {
      cursor.fail("expected one object key");
    }
    const key = parseString(cursor);
    cursor.whitespace();
    if (!cursor.eat(":")) {
      cursor.fail("expected one colon after one object key");
    }
    const value = parseValue(cursor, depth + 1);
    // Defined, not assigned: one assignment to one key such as `__proto__`
    // follows the accessor of `Object.prototype` and silently drops or
    // relocates the value.
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    cursor.whitespace();
    if (cursor.eat(",")) {
      continue;
    }
    if (cursor.eat("}")) {
      return result;
    }
    cursor.fail("expected one comma or one closing brace");
  }
}

/** Parses one array. */
function parseArray(cursor: Cursor, depth: number): unknown[] {
  cursor.eat("[");
  const result: unknown[] = [];
  cursor.whitespace();
  if (cursor.eat("]")) {
    return result;
  }
  for (;;) {
    result.push(parseValue(cursor, depth + 1));
    cursor.whitespace();
    if (cursor.eat(",")) {
      continue;
    }
    if (cursor.eat("]")) {
      return result;
    }
    cursor.fail("expected one comma or one closing bracket");
  }
}

/** Parses one string with every escape of the strict grammar. */
function parseString(cursor: Cursor): string {
  cursor.eat('"');
  let result = "";
  for (;;) {
    if (cursor.atEnd()) {
      cursor.fail("the string never closed");
    }
    const character = cursor.peek();
    if (character === '"') {
      cursor.eat('"');
      return result;
    }
    if (character === "\\") {
      cursor.eat("\\");
      const escape = cursor.peek();
      if (escape === "u") {
        cursor.eat("u");
        result += parseUnicodeEscape(cursor);
        continue;
      }
      const simple: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      const mapped = simple[escape];
      if (mapped === undefined) {
        cursor.fail(`unknown escape ${JSON.stringify(escape)}`);
      }
      cursor.eat(escape);
      result += mapped;
      continue;
    }
    result += cursor.readWhile(() => cursor.peek() !== '"' && cursor.peek() !== "\\");
  }
}

/** Parses one `\uXXXX` escape, joining one surrogate pair when one follows. */
function parseUnicodeEscape(cursor: Cursor): string {
  const first = readHex(cursor);
  if (first >= 0xd800 && first <= 0xdbff) {
    if (!cursor.eat("\\") || !cursor.eat("u")) {
      cursor.fail("one high surrogate has no low surrogate");
    }
    const second = readHex(cursor);
    if (second < 0xdc00 || second > 0xdfff) {
      cursor.fail("one high surrogate is followed by no low surrogate");
    }
    return String.fromCodePoint((first - 0xd800) * 0x400 + (second - 0xdc00) + 0x10000);
  }
  return String.fromCodePoint(first);
}

/** Reads exactly four hexadecimal digits as one code point. */
function readHex(cursor: Cursor): number {
  let digits = "";
  while (digits.length < 4) {
    const character = cursor.peek();
    if (!/[0-9a-fA-F]/.test(character) || character === "") {
      cursor.fail("expected four hexadecimal digits");
    }
    digits += character;
    cursor.eat(character);
  }
  return Number.parseInt(digits, 16);
}

/** Parses one literal word. */
function parseWord(cursor: Cursor, word: string, value: unknown): unknown {
  for (const character of word) {
    if (!cursor.eat(character)) {
      cursor.fail(`expected the word ${word}`);
    }
  }
  return value;
}

/**
 * Parses one number.
 *
 * The grammar accepts the strict JSON number form alone: one optional
 * minus, one integer with no leading zero, one optional fraction with at
 * least one digit, and one optional exponent. One integer literal inside
 * the safe JavaScript range parses as one `number`. One integer literal
 * beyond it parses as one `BigInt`, so the wrapper receives the value the
 * core read instead of one rounded double. Every other number parses as
 * one `number`.
 */
function parseNumber(cursor: Cursor): number | bigint {
  const text = cursor.readWhile(
    (character) => "+-.eE0123456789".includes(character) && character !== "",
  );
  // The whole-token test runs first, so one spelling that strict JSON
  // refuses, such as one leading zero, one bare dot, or one trailing dot,
  // never reaches the conversions.
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(text)) {
    cursor.fail(`invalid number ${text}`);
  }
  if (!/[.eE]/.test(text)) {
    const exact = BigInt(text);
    const rounded = Number(exact);
    // The safe range check keeps every integer that round-trips through
    // one double as itself.
    if (BigInt(rounded) === exact) {
      return rounded;
    }
    return exact;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    cursor.fail(`invalid number ${text}`);
  }
  return value;
}
