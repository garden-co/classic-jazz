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

/**
 * A coValue long enough to be split across signature checkpoints — the case the
 * batched whole-coValue read deliberately skips. Returns the reads a load costs
 * plus the content it produced.
 */
async function loadStreamingCoValue(txCount: number) {
  const driver = new CountingDriver(newDbPath());
  const storage = await getSqliteStorageAsync(driver);

  const node = setupTestNode().node;
  const group = node.createGroup();
  const map = group.createMap();
  for (let i = 0; i < txCount; i++) {
    map.set(`k${i}`, "A".repeat(2048));
  }
  await map.core.waitForSync();

  for (const msg of map.core.verified.newContentSince(undefined) ?? []) {
    await new Promise<void>((resolve) => {
      storage.store(msg, () => undefined, resolve);
    });
  }

  storage.onCoValueUnmounted(map.id);
  driver.reads = [];

  const content: NewContentMessage[] = [];
  await new Promise<void>((resolve) => {
    storage.load(
      map.id,
      (data) => content.push(data),
      () => resolve(),
    );
  });
  await storage.close();

  const flatten = (msgs: NewContentMessage[]) =>
    msgs.flatMap((msg) =>
      Object.values(msg.new).flatMap((entry) => entry.newTransactions),
    );

  return {
    txReads: driver.reads.filter((sql) => sql.includes("FROM transactions"))
      .length,
    transactions: flatten(content),
    // What was written, in order — the batched read has to reproduce it exactly.
    expected: flatten(map.core.verified.newContentSince(undefined) ?? []),
  };
}

test("a corrupt transaction row only costs its own session", async () => {
  const driver = new CountingDriver(newDbPath());
  const storage = await getSqliteStorageAsync(driver);

  const node = setupTestNode().node;
  const group = node.createGroup();
  const map = group.createMap();
  map.set("hello", "world");
  await map.core.waitForSync();

  const original = map.core.verified.newContentSince(undefined)?.[0];
  if (!original) throw new Error("no content to store");

  const [firstSessionID] = Object.keys(original.new) as SessionID[];
  if (!firstSessionID) throw new Error("content has no sessions");
  const entry = original.new[firstSessionID]!;

  const msg: NewContentMessage = {
    ...original,
    new: Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [
        `${firstSessionID}${i === 0 ? "" : `-clone${i}`}` as SessionID,
        { ...entry, newTransactions: [...entry.newTransactions] },
      ]),
    ),
  };

  await new Promise<void>((resolve) => {
    storage.store(msg, () => undefined, resolve);
  });

  // The batched whole-coValue read parses every row under a single try/catch,
  // so one bad row makes it return nothing for every session. Falling back to
  // the per-session reads has to still recover the two intact ones.
  const sessions = await driver.query<{ rowID: number }>(
    "SELECT rowID FROM sessions WHERE coValue = (SELECT rowID FROM coValues WHERE id = ?) ORDER BY rowID",
    [map.id],
  );
  expect(sessions).toHaveLength(3);
  await driver.run("UPDATE transactions SET tx = 'not json' WHERE ses = ?", [
    sessions[0]!.rowID,
  ]);

  storage.onCoValueUnmounted(map.id);

  const content: NewContentMessage[] = [];
  await new Promise<void>((resolve) => {
    storage.load(
      map.id,
      (data) => content.push(data),
      () => resolve(),
    );
  });
  await storage.close();

  // An empty session entry is still emitted for the corrupt one, so count the
  // transactions actually recovered: 2 of 3 with the fallback, 0 without it.
  const loadedTxs = content.flatMap((m) =>
    Object.values(m.new).flatMap((e) => e.newTransactions),
  );
  expect(loadedTxs).toHaveLength(2);
});

test("a streaming coValue is read in batched checkpoint windows", async () => {
  // 2KB values against a 100KB checkpoint means ~50 transactions per
  // checkpoint, so this spans well over SIGNATURE_READ_BATCH checkpoints.
  const { txReads, transactions, expected } = await loadStreamingCoValue(1000);

  // Slicing a multi-checkpoint window by hand can drop, duplicate or reorder
  // transactions without changing the count, so compare the whole log.
  expect(transactions).toHaveLength(1000);
  expect(transactions).toEqual(expected);

  // One read per checkpoint would be ~20+; batching 10 at a time is ~2-3.
  expect(txReads).toBeGreaterThan(0);
  expect(txReads).toBeLessThan(5);
});

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
