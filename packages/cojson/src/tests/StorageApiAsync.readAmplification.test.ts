import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database, { type Database as DatabaseT } from "libsql";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionID } from "../exports.js";
import { getSqliteStorageAsync } from "../storage/sqliteAsync/index.js";
import type { SQLiteDatabaseDriverAsync } from "../storage/sqliteAsync/types.js";
import type { NewContentMessage } from "../sync.js";
import { setupTestNode } from "./testUtils.js";

/**
 * Loading a coValue used to issue one `signatureAfter` query and one
 * `transactions` query per session — `2 + 2 * sessions` reads. Signatures are
 * rare, so nearly all of those queries returned nothing.
 *
 * This asserts the per-session queries are batched, i.e. the read count no
 * longer grows with the session count.
 */
class CountingDriver implements SQLiteDatabaseDriverAsync {
  private readonly db: DatabaseT;
  public reads: string[] = [];

  constructor(filename: string) {
    this.db = new Database(filename, {});
  }

  async initialize() {
    await this.db.pragma("journal_mode = WAL");
  }

  private record(sql: string) {
    this.reads.push(sql.replace(/\s+/g, " ").trim());
  }

  async run(sql: string, params: unknown[]) {
    this.db.prepare(sql).run(params);
  }

  async query<T>(sql: string, params: unknown[]): Promise<T[]> {
    this.record(sql);
    return this.db.prepare(sql).all(params) as T[];
  }

  async get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    this.record(sql);
    return this.db.prepare(sql).get(params) as T | undefined;
  }

  async transaction(callback: (tx: CountingDriver) => unknown) {
    await this.run("BEGIN TRANSACTION", []);
    try {
      await callback(this);
      await this.run("COMMIT", []);
    } catch (error) {
      await this.run("ROLLBACK", []);
      throw error;
    }
  }

  async closeDb() {
    this.db.close();
  }
}

const dbPaths: string[] = [];

function newDbPath() {
  const path = join(tmpdir(), `jazz-read-amp-${randomUUID()}.db`);
  dbPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of dbPaths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${path}${suffix}`);
      } catch {
        // already gone
      }
    }
  }
});

/**
 * Stores a coValue whose content is spread across `sessionCount` sessions, then
 * returns how many reads a single load of it costs.
 */
async function readsToLoadCoValueWithSessions(sessionCount: number) {
  const driver = new CountingDriver(newDbPath());
  const storage = await getSqliteStorageAsync(driver);

  const node = setupTestNode().node;
  const group = node.createGroup();
  const map = group.createMap();
  map.set("hello", "world");
  await map.core.waitForSync();

  const original = map.core.verified.newContentSince(undefined)?.[0];
  if (!original) throw new Error("no content to store");

  // Fan the same session entry out across N distinct session IDs. Storage
  // persists sessions verbatim and does not verify signatures, so this
  // faithfully reproduces a coValue with many writers.
  const [firstSessionID] = Object.keys(original.new) as SessionID[];
  if (!firstSessionID) throw new Error("content has no sessions");
  const entry = original.new[firstSessionID]!;

  const msg: NewContentMessage = {
    ...original,
    new: Object.fromEntries(
      Array.from({ length: sessionCount }, (_, i) => [
        `${firstSessionID}${i === 0 ? "" : `-clone${i}`}` as SessionID,
        { ...entry, newTransactions: [...entry.newTransactions] },
      ]),
    ),
  };

  await new Promise<void>((resolve) => {
    storage.store(msg, () => undefined, resolve);
  });

  // A loaded coValue is served from memory, so drop that bookkeeping to force
  // this load to actually hit the database.
  storage.onCoValueUnmounted(map.id);
  driver.reads = [];

  await storage.load(map.id, vi.fn(), vi.fn());
  await storage.close();

  return driver.reads;
}

test("load cost does not grow with the number of sessions", async () => {
  const oneSession = await readsToLoadCoValueWithSessions(1);
  const manySessions = await readsToLoadCoValueWithSessions(30);

  const countMatching = (reads: string[], table: string) =>
    reads.filter((sql) => sql.includes(`FROM ${table}`)).length;

  // The two formerly per-session queries are now one apiece, either way.
  for (const reads of [oneSession, manySessions]) {
    expect(countMatching(reads, "signatureAfter")).toBe(1);
    expect(countMatching(reads, "transactions")).toBe(1);
  }

  expect(manySessions.length).toBe(oneSession.length);
});
