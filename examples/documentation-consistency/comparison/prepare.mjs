// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export async function prepare() {
  const names = ["contracts/v0/hashing.md", "docs/reference/artifacts.md", "docs/reference/api.md",
    "packages/measuretwice/src/exploration.ts", "packages/measuretwice/src/cli.ts"];
  const texts = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(path.join(root, name), "utf8")])));
  const sources = names.map(name => ({ path: name, sha256: createHash("sha256").update(texts[name]).digest("hex") }));
  function excerpt(name, expression) {
    const matches = [...texts[name].matchAll(expression)];
    if (matches.length !== 1) throw new Error(`Expected one source excerpt in ${name}. Review the extractor before rerunning.`);
    const match = matches[0];
    return { text: match[0].trim(), path: name, line: texts[name].slice(0, match.index).split("\n").length };
  }
  const unicode = excerpt(names[0], /### Length counting\n[\s\S]*?(?=\n### )/g);
  const unicodeDoc = excerpt(names[1], /The length of one string is\n[\s\S]*?its own code point\./g);
  const cutoffs = excerpt(names[3], /const STARTER_POLICY:[\s\S]*?\n\}\);/g);
  const cutoffsDoc = excerpt(names[2], /\*\*Default starter policy:\*\*[^\n]*\nwith no confidence floor\./g);
  const mode = excerpt(names[4], /  --mode <shadow\|enforcement>\n[^\n]+Default: shadow\./g);
  const modeDoc = excerpt(names[2], /\*\*Modes:\*\* `shadow` is the default\./g);
  const inputs = [
    [unicode, unicodeDoc.text, "unicode-length", "supported", "The candidate uses the contract's code point semantics.", "collected"],
    [cutoffs, cutoffsDoc.text, "starter-policy", "supported", "The constant records both cutoffs and has no confidence floor.", "collected"],
    [mode, modeDoc.text, "run-mode", "supported", "The supplied mode excerpt explicitly states the default.", "collected"],
    [unicode, "The maxLength rule counts UTF-16 code units. One emoji counts twice.", "unicode-length", "contradicted", "The inserted claim contradicts the supplied code point semantics.", "synthetic"],
    [cutoffs, "The default starter policy uses accept_cutoff 0.6 and rejection_cutoff 0.8.", "starter-policy", "contradicted", "The inserted claim reverses both cutoffs.", "synthetic"],
    [{ ...mode, text: mode.text.split("\n")[0] }, modeDoc.text, "run-mode", "insufficient", "The cropped evidence lists modes but states no default.", "synthetic"],
  ];
  const cases = inputs.map(([source, candidate, group], index) => ({
    id: `doc-${String(index + 1).padStart(2, "0")}`, group,
    input: { evidence: source.text, candidate }, source: { path: source.path, line: source.line },
    ...(index < 3 ? { candidate_source: {
      path: [unicodeDoc, cutoffsDoc, modeDoc][index].path,
      line: [unicodeDoc, cutoffsDoc, modeDoc][index].line,
    } } : {}),
  }));
  const references = inputs.map(([, , , answer, reason, origin], index) => ({
    case: cases[index].id, answer,
    label: { author_type: "model", origin, reviewed: false, reason },
  }));
  const review = "# Review documentation cases\n\nStatus: awaiting independent human review.\n\n" +
    "Read only this sheet before assigning answers. Do not inspect references or evaluator results.\n" +
    "Use supported when the evidence establishes every claim. Use contradicted for an established contradiction.\n" +
    "Use insufficient when evidence is missing or ambiguous without an established contradiction.\n" +
    "Record the decisive source words, reviewer identity, review date, and any uncertainty.\n\n" +
    cases.map(item => `## ${item.id}\n\nEvidence:\n\n~~~~text\n${item.input.evidence}\n~~~~\n\n` +
      `Candidate:\n\n~~~~text\n${item.input.candidate}\n~~~~\n\n` +
      "Answer: __________\n\nDecisive source words: __________\n\nReviewer and date: __________\n\nUncertainty: __________\n").join("\n");
  return { cases, references, sources, review };
}
