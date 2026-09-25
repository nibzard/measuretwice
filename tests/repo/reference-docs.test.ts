// SPDX-License-Identifier: Apache-2.0
/**
 * Reference-document checks for docs/reference.
 *
 * Task T071 publishes the API, schema, and CLI references. These checks tie
 * the published pages to the implemented surface, so one edited page or one
 * renamed export fails here instead of misleading one reader:
 *
 * - Every fenced TypeScript example of the reference compiles against the
 *   built package. The check writes each block into one generated project
 *   under `build/` and runs the pinned `tsc` once. `npm run build` must run
 *   first, as for the packaging checks.
 * - Every imported name of the pages exists on the compiled public entry
 *   point, so the pages document no export that the package withdrew.
 * - Every `--option` that the CLI reference names appears in the compiled
 *   usage text, so the page documents no option that the CLI dropped.
 * - Every schema file that a page names exists in `contracts/v0`, and every
 *   fenced JSON block parses.
 *
 * The checks read local files only. They open no network connection, so
 * they stay deterministic and free.
 */
import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const referenceDir = path.join(repoRoot, "docs", "reference");
const contractsDir = path.join(repoRoot, "contracts", "v0");
const compiledEntry = path.join(repoRoot, "packages", "measuretwice", "dist", "index.js");
const compiledCli = path.join(repoRoot, "packages", "measuretwice", "dist", "cli.js");
const generatedDir = path.join(repoRoot, "build", "reference-docs");

/** One fenced code block of one markdown file. */
interface CodeBlock {
  /** The page file name, relative to `docs/reference`. */
  readonly page: string;
  /** The fence language, lowercase. Empty when the fence states none. */
  readonly language: string;
  /** The complete block text, without the fences. */
  readonly text: string;
}

function referencePages(): string[] {
  return readdirSync(referenceDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

function codeBlocks(markdown: string, page: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const pattern = /^```([\w-]*)[ \t]*$\n([\s\S]*?)^```[ \t]*$/gm;
  for (const match of markdown.matchAll(pattern)) {
    blocks.push({ page, language: match[1] ?? "", text: match[2] ?? "" });
  }
  return blocks;
}

function allBlocks(): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (const page of referencePages()) {
    blocks.push(...codeBlocks(readFileSync(path.join(referenceDir, page), "utf8"), page));
  }
  return blocks;
}

test("the reference directory holds the published pages", () => {
  expect(referencePages().length).toBeGreaterThan(0);
  for (const page of referencePages()) {
    expect(page, "page names use lowercase and hyphens").toMatch(/^[a-z-]+\.md$/);
  }
});

test("every TypeScript example of the reference compiles against the built package", () => {
  const examples = allBlocks().filter((block) => block.language === "ts");
  expect(examples.length, "the reference holds TypeScript examples").toBeGreaterThan(0);

  rmSync(generatedDir, { recursive: true, force: true });
  mkdirSync(generatedDir, { recursive: true });
  const imports: string[] = [];
  for (const [index, block] of examples.entries()) {
    const file = path.join(generatedDir, `example-${String(index + 1).padStart(3, "0")}.ts`);
    writeFileSync(file, block.text, "utf8");
    imports.push(`${path.basename(file)}: ${block.page}`);
  }
  writeFileSync(path.join(generatedDir, "examples.txt"), `${imports.join("\n")}\n`, "utf8");
  // The generated project extends the repository configuration, so the
  // examples compile under the same strictness as the package sources. The
  // files sit below the repository root, so `measuretwice` and `typebox`
  // resolve through the workspace installs of the root.
  writeFileSync(
    path.join(generatedDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: { types: ["node"], noEmit: true },
        include: ["*.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  execFileSync(
    process.execPath,
    [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", generatedDir],
    { encoding: "utf8" },
  );
}, 240_000);

test("every imported name of the reference exists on the compiled entry point", async () => {
  expect(existsSync(compiledEntry), "run npm run build before this check").toBe(true);
  const module = (await import(pathToFileURL(compiledEntry).href)) as Record<string, unknown>;
  const values = new Set<string>();
  for (const block of allBlocks()) {
    // One import statement spans several lines in the pages. A type-only
    // import or one inline `type` name binds no runtime value, so the
    // compile check above owns those names alone.
    for (const statement of block.text.matchAll(
      /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"measuretwice"/g,
    )) {
      if (statement[1] !== undefined) {
        continue;
      }
      for (const raw of statement[2]?.split(",") ?? []) {
        const segment = raw.trim();
        if (segment === "" || /^type\s/.test(segment)) {
          continue;
        }
        const name = segment.split(/\s+as\s+/)[0];
        if (name !== undefined && name !== "") {
          values.add(name);
        }
      }
    }
  }
  expect(values.size, "the reference imports value names from the package").toBeGreaterThan(0);
  const missing = [...values].filter((name) => module[name] === undefined);
  expect(missing, `the package exports none of: ${missing.join(", ")}`).toEqual([]);
});

test("every CLI option of the reference appears in the compiled usage text", async () => {
  expect(existsSync(compiledCli), "run npm run build before this check").toBe(true);
  const cli = (await import(pathToFileURL(compiledCli).href)) as { USAGE: string };
  const cliPage = readFileSync(path.join(referenceDir, "cli.md"), "utf8");
  const options = new Set<string>();
  for (const match of cliPage.matchAll(/--([a-z][a-z-]*)/g)) {
    options.add(match[1] as string);
  }
  expect(options.size).toBeGreaterThan(0);
  const missing = [...options].filter((option) => !cli.USAGE.includes(`--${option}`));
  expect(missing, `the compiled CLI states none of: ${missing.join(", ")}`).toEqual([]);
});

test("every schema file the reference names exists in the frozen contracts", () => {
  const frozen = new Set(
    readdirSync(contractsDir).filter((name) => name.endsWith(".md") || name.endsWith(".json")),
  );
  const problems: string[] = [];
  for (const block of allBlocks()) {
    const withoutCodeSpans = block.text.replaceAll(/`[^`\n]*`/g, "");
    for (const match of withoutCodeSpans.matchAll(/([a-z-]+\.schema\.json)/g)) {
      const name = match[1] as string;
      if (!frozen.has(name)) {
        problems.push(`${block.page} names ${name} which is not published`);
      }
    }
  }
  for (const page of referencePages()) {
    const markdown = readFileSync(path.join(referenceDir, page), "utf8");
    const withoutFences = markdown.replaceAll(/^```[\s\S]*?^```$/gm, "");
    for (const match of withoutFences.matchAll(/([a-z-]+\.schema\.json)/g)) {
      const name = match[1] as string;
      if (!frozen.has(name)) {
        problems.push(`${page} names ${name} which is not published`);
      }
    }
  }
  expect(problems).toEqual([]);
});

test("every JSON block of the reference parses", () => {
  for (const block of allBlocks().filter((named) => named.language === "json")) {
    const parse = (): void => {
      JSON.parse(block.text);
    };
    expect(parse, `${block.page} holds one invalid JSON block`).not.toThrow();
  }
});

