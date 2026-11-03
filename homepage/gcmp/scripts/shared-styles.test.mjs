import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("shared styles can resolve the Tailwind CSS entry from their own package", () => {
  const require = createRequire(
    new URL("../../design-system/src/app/globals.css", import.meta.url),
  );
  const packageDirectory = dirname(require.resolve("tailwindcss/package.json"));
  const css = readFileSync(join(packageDirectory, "index.css"), "utf8");
  assert.match(css, /@layer/);
});
