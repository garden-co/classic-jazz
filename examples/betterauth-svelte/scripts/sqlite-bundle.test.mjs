import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build, loadConfigFromFile } from "vite";

test("the bundled Better Auth SQLite adapter loads and executes a query", async () => {
  const require = createRequire(import.meta.url);
  const adapter = path.join(path.dirname(require.resolve("better-auth")), "adapters/kysely-adapter/node-sqlite-dialect.mjs");
  const { config } = await loadConfigFromFile({ command: "build", mode: "production" });
  const directory = await mkdtemp(path.join(process.cwd(), ".sqlite-bundle-test-"));
  let driver;
  try {
    await build({
      configFile: false,
      logLevel: "silent",
      ssr: config.ssr,
      build: {
        ssr: adapter,
        outDir: directory,
        rollupOptions: { output: { entryFileNames: "adapter.mjs" } },
      },
    });
    const { NodeSqliteDialect } = await import(pathToFileURL(path.join(directory, "adapter.mjs")));
    driver = new NodeSqliteDialect({ database: new DatabaseSync(":memory:") }).createDriver();
    await driver.init();
    const connection = await driver.acquireConnection();
    const result = await connection.executeQuery({ sql: "select 1 as value", parameters: [] });
    assert.equal(result.rows[0].value, 1);
    await driver.releaseConnection(connection);
  } finally {
    await driver?.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
