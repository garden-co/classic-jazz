import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DOC_SECTIONS, FRAMEWORKS } from "./utils/config.mjs";

const warning = `**Classic Jazz documentation — for existing Classic Jazz projects**

Classic Jazz is no longer under active development. **For new projects, use Jazz v2.0 or later and the [current documentation](https://jazz.tools/docs).**

**Use this documentation only when your project uses Classic Jazz.** Its APIs and examples are not guidance for Jazz v2.0 or later. If you are unsure which version your project uses, check its dependencies before following these instructions.`;

function plain(text) {
  return text.replace(/[*>\\]/g, "").replace(/\s+/g, " ").trim();
}

function assertWarning(content, name) {
  const position = plain(content).indexOf(plain(warning));
  assert.ok(position >= 0 && position < 200, `${name}: complete warning must precede instructional content`);
}

async function filesIn(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(filename) : filename;
  }))).flat();
}

test("every Classic docs source carries the literal warning first", async () => {
  const sources = (await filesIn("content/docs")).filter((file) => file.endsWith(".mdx"));
  assert.ok(sources.length > 0);
  for (const source of sources) {
    const content = await fs.readFile(source, "utf8");
    assert.ok(content.startsWith('<aside className="classic-docs-warning"'), `${source}: visible warning first`);
    assertWarning(content, source);
  }
});

test("every expected Markdown page is generated with the warning", async () => {
  const sources = (await filesIn("content/docs"))
    .filter((file) => file.endsWith(".mdx") && !file.includes(`${path.sep}upgrade${path.sep}`));
  const expected = FRAMEWORKS.map((framework) => `public/docs/${framework}.md`);
  for (const source of sources) {
    const relative = path.relative("content/docs", source);
    const framework = path.basename(relative, ".mdx");
    if (FRAMEWORKS.includes(framework)) {
      expected.push(path.join("public/docs", framework, `${path.dirname(relative)}.md`));
    } else {
      for (const prefix of ["", ...FRAMEWORKS]) {
        expected.push(path.join("public/docs", prefix, relative.replace(/\.mdx$/, ".md")));
      }
    }
  }
  const emitted = (await filesIn("public/docs")).filter((file) => file.endsWith(".md"));
  for (const file of new Set([...expected, ...emitted])) {
    assertWarning(await fs.readFile(file, "utf8"), file);
  }
});

test("all LLM exports identify Classic and retain each embedded page warning", async () => {
  for (const framework of ["", ...FRAMEWORKS]) {
    for (const name of ["llms.txt", "llms-full.txt"]) {
      const filename = path.join("public", framework, name);
      const content = await fs.readFile(filename, "utf8");
      assert.match(content, /^# Classic Jazz(?: \([^\n]+\))?\n/);
      assertWarning(content, filename);
      for (const section of DOC_SECTIONS) {
        for (const page of section.pages) {
          const heading = `### ${page.title}\n`;
          const start = content.indexOf(heading);
          assert.ok(start >= 0, `${filename}: missing ${page.title}`);
          const rest = content.slice(start + heading.length).trimStart();
          // Empty framework variants have no page content to label.
          if (!rest || rest.startsWith("## ") || rest.startsWith("### ")) continue;
          assertWarning(rest, `${filename}: ${page.title}`);
        }
      }
    }
  }
});

test("the public agent guide and its template carry the warning", async () => {
  for (const filename of ["scripts/user-agents-template.md", "public/AGENTS.md"]) {
    assertWarning(await fs.readFile(filename, "utf8"), filename);
  }
});
