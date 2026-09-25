// SPDX-License-Identifier: Apache-2.0
/**
 * Documentation-link checks.
 *
 * Every relative link and image in the controlled markdown files must name
 * an existing file, and every markdown anchor must name an existing heading.
 * The check reads local files only. It never opens a network connection, so
 * it stays deterministic and free.
 *
 * `research/` is historical background, as AGENTS.md records. Its records
 * keep their original links, which may name files outside this repository,
 * so the check skips that directory.
 */
import { test, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ROOT_DOCUMENTS = ["README.md", "AGENTS.md", "DEVELOPING.md", "MVP_SPEC.md", "TESTING.md"];
const INCLUDED_DIRECTORIES = [
  "contracts",
  ".measuretwice",
  "docs",
  "examples",
  "fixtures",
  "models",
  "providers",
];
const EXCLUDED_DIRECTORIES = new Set(["research", "node_modules", "target", "dist", ".git"]);

function markdownFiles(): string[] {
  const files = ROOT_DOCUMENTS.map((name) => path.join(repoRoot, name));
  for (const directory of INCLUDED_DIRECTORIES) {
    const stack = [path.join(repoRoot, directory)];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of readdirSync(current)) {
        const full = path.join(current, entry);
        if (statSync(full).isDirectory()) {
          stack.push(full);
        } else if (entry.endsWith(".md")) {
          files.push(full);
        }
      }
    }
  }
  return files.map((file) => path.relative(repoRoot, file)).sort();
}

/** Removes fenced code blocks. */
function withoutFencedBlocks(markdown: string): string {
  return markdown
    .replaceAll(/^```[\s\S]*?^```$/gm, "")
    .replaceAll(/^~~~[\s\S]*?^~~~$/gm, "");
}

/** Removes fenced code blocks, then inline code spans. */
function withoutCode(markdown: string): string {
  return withoutFencedBlocks(markdown).replaceAll(/`[^`\n]*`/g, "");
}

/**
 * Collects GitHub-style heading anchors, with duplicate numbering.
 *
 * The slug keeps the text inside code spans, as GitHub does, so one heading
 * that names one identifier in backticks keeps that identifier in its
 * anchor. Only the fenced blocks leave, because one `#` line inside one
 * fence is no heading.
 */
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of withoutFencedBlocks(markdown).split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading === null) {
      continue;
    }
    const slug = heading[2]
      ?.trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replaceAll(/\s+/g, "-") ?? "";
    if (slug === "") {
      continue;
    }
    const seen = counts.get(slug) ?? 0;
    counts.set(slug, seen + 1);
    anchors.add(seen === 0 ? slug : `${slug}-${seen}`);
  }
  return anchors;
}

interface Link {
  target: string;
  location: string;
}

function collectLinks(file: string): Link[] {
  const markdown = readFileSync(path.join(repoRoot, file), "utf8");
  const links: Link[] = [];
  const pattern = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  for (const match of withoutCode(markdown).matchAll(pattern)) {
    const target = match[1];
    if (target !== undefined) {
      links.push({ target, location: file });
    }
  }
  return links;
}

function describeLink(link: Link, fragment: string): string {
  return fragment === ""
    ? `${link.location} links to ${link.target}`
    : `${link.location} links to ${link.target} (fragment ${fragment})`;
}

test("every relative documentation link names an existing file or directory", () => {
  expect(markdownFiles().length).toBeGreaterThan(0);
  const problems: string[] = [];
  for (const file of markdownFiles()) {
    for (const link of collectLinks(file)) {
      const { target } = link;
      if (/^(https?:|mailto:|data:)/i.test(target)) {
        continue;
      }
      const withoutFragment = target.replace(/#.*$/, "");
      const fragment = target.includes("#") ? (target.split("#")[1] ?? "") : "";
      let anchorFile = file;
      if (withoutFragment !== "") {
        let decoded = withoutFragment;
        try {
          decoded = decodeURIComponent(withoutFragment);
        } catch {
          problems.push(describeLink(link, fragment) + " holds an invalid escape");
          continue;
        }
        const resolved = path.resolve(path.dirname(path.join(repoRoot, file)), decoded);
        if (!existsSync(resolved)) {
          problems.push(describeLink(link, fragment) + " which does not exist");
          continue;
        }
        anchorFile = path.relative(repoRoot, resolved);
      }
      if (fragment === "" || !anchorFile.endsWith(".md")) {
        continue;
      }
      const anchors = headingAnchors(readFileSync(path.join(repoRoot, anchorFile), "utf8"));
      if (!anchors.has(fragment)) {
        problems.push(describeLink(link, fragment) + " but the heading is missing");
      }
    }
  }
  expect(problems).toEqual([]);
});
