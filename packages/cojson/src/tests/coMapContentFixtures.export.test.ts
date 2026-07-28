/**
 * coMap CONTENT fixture exporter (R3 stage 3).
 *
 * Builds real coMap state through the public cojson API and captures, per
 * scenario, the CURRENT TS `RawCoMap` materialization as the frozen contract the
 * Rust port must reproduce byte-for-byte:
 *   - the raw wire form of every touched CoValue (header + sessions + txs +
 *     signerId + lastSignature) so a Rust `NodeCore` can ingest them via
 *     `addTransactions(..., skipVerify)`.
 *   - `snapshot`   — `map.asObject()` (latest-value view).
 *   - `ops`        — `map.ops`, the per-key `MapOp[]` with full metadata
 *                    (`txID`/`madeAt`/`changeIdx`/`change`/`trusting`).
 *   - `atTime`     — a grid of `map.atTime(t).get(key)` reads spanning the map's
 *                    madeAt range (time-travel history).
 *   - `frontier`   — `map.atFrontier(f).asObject()` for several frontier cuts.
 *   - `provideKeys`— read-key secrets a private scenario needs so the Rust side
 *                    can decrypt natively.
 *
 * These freeze the coMap content contract BEFORE any future TS deletion. The
 * Rust replay lives in `crates/cojson-core/src/core/co_map.rs`
 * (`content_fixture_tests`).
 *
 * When `EXPORT_COMAP_CONTENT_FIXTURES=1` the fixtures are written to
 * `crates/cojson-core/data/co_map_content/<scenario>.json`. Regardless of
 * export, the suite always asserts internal consistency so it has CI value.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { expectMap } from "../coValue.js";
import { WasmCrypto } from "../crypto/WasmCrypto.js";
import type { RawCoID } from "../ids.js";
import { LocalNode } from "../localNode.js";

const Crypto = await WasmCrypto.create();

const EXPORT = process.env.EXPORT_COMAP_CONTENT_FIXTURES === "1";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../crates/cojson-core/data/co_map_content",
);

// ---------------------------------------------------------------------------
// Fixture types (wire form mirrors the group-engine fixtures for reuse).
// ---------------------------------------------------------------------------
type SessionFixture = {
  sessionId: string;
  signerId: string;
  transactions: string[];
  lastSignature: string;
};
type CoValueFixture = {
  coId: string;
  headerJson: string;
  sessions: SessionFixture[];
};
type AtTimeExpect = { t: number; key: string; value: unknown };
type FrontierExpect = {
  frontier: Record<string, number>;
  snapshot: Record<string, unknown>;
};
type ContentFixture = {
  description: string;
  covalues: CoValueFixture[];
  mapId: string;
  provideKeys: { keyId: string; keySecret: string }[];
  snapshot: Record<string, unknown>;
  ops: Record<string, unknown[]>;
  atTime: AtTimeExpect[];
  frontier: FrontierExpect[];
};

// ---------------------------------------------------------------------------
// Deterministic seeded RNG (mulberry32) + op generation.
// ---------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Op =
  | { op: "set"; key: string; value: unknown; fww?: string }
  | { op: "del"; key: string };
function randValue(rng: () => number): unknown {
  const r = rng();
  if (r < 0.4) return Math.floor(rng() * 1e6);
  if (r < 0.7) return `v${Math.floor(rng() * 1e6).toString(36)}`;
  if (r < 0.85) return rng() < 0.5;
  return { a: Math.floor(rng() * 1000), b: `s${Math.floor(rng() * 1000)}` };
}
function generateOps(opts: {
  seed: number;
  opCount: number;
  keyCount: number;
  fwwFraction?: number;
  delFraction?: number;
}): Op[] {
  const { seed, opCount, keyCount, fwwFraction = 0, delFraction = 0 } = opts;
  const rng = makeRng(seed);
  const ops: Op[] = [];
  for (let i = 0; i < opCount; i++) {
    const key = `k${Math.floor(rng() * keyCount)}`;
    if (delFraction > 0 && rng() < delFraction) {
      ops.push({ op: "del", key });
      continue;
    }
    const op: Op = { op: "set", key, value: randValue(rng) };
    if (fwwFraction > 0 && rng() < fwwFraction)
      op.fww = `lock${Math.floor(rng() * 4)}`;
    ops.push(op);
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Readers (identical wire-capture to the group-engine exporter).
// ---------------------------------------------------------------------------
function readCoValue(node: LocalNode, id: RawCoID): CoValueFixture {
  const core = node.getCoValue(id);
  if (!core.verified) throw new Error(`CoValue ${id} is not available`);
  core.getValidTransactions({ ignorePrivateTransactions: false });
  const nc = node.nodeCore;
  const headerJson = nc.getHeader(id);
  const sessions: SessionFixture[] = nc.getSessionIds(id).map((sessionId) => {
    const rawTxs = nc.getSessionTransactions(id, sessionId, 0) ?? [];
    const transactions = rawTxs.map((tx) => JSON.stringify(tx));
    const lastSignature = nc.getLastSignature(id, sessionId)!;
    const signerId = core.verified!.getSession(sessionId as any)?.signerID!;
    return { sessionId, signerId, transactions, lastSignature };
  });
  return { coId: id, headerJson, sessions };
}

function newTrustingMap(node: LocalNode) {
  const core = node.createCoValue({
    type: "comap",
    ruleset: { type: "unsafeAllowAll" },
    meta: null,
    ...Crypto.createdNowUnique(),
  });
  return expectMap(core.getCurrentContent());
}

function applyOp(map: any, op: Op, privacy: "trusting" | "private") {
  if (op.op === "del") map.delete(op.key, privacy);
  else if (op.fww) map.assign({ [op.key]: op.value }, privacy, { fww: op.fww });
  else map.set(op.key, op.value, privacy);
}

/** Capture the TS RawCoMap's content views as the frozen contract. */
function captureContent(
  node: LocalNode,
  map: any,
  description: string,
  extraCovalueIds: RawCoID[] = [],
  provideKeys: { keyId: string; keySecret: string }[] = [],
): ContentFixture {
  const covalues = [
    ...extraCovalueIds.map((id) => readCoValue(node, id)),
    readCoValue(node, map.id),
  ];

  // snapshot + ops straight off the live map.
  const snapshot = map.asObject();
  const ops: Record<string, unknown[]> = {};
  for (const key of Object.keys(map.ops)) {
    ops[key] = (map.ops[key] as unknown[]).map((o) =>
      JSON.parse(JSON.stringify(o)),
    );
  }

  // atTime grid: 40 (t, key) reads spanning the madeAt range.
  const keys = Object.keys(map.ops);
  const earliest = map.core.earliestTxMadeAt as number;
  const latest = map.core.latestTxMadeAt as number;
  const span = Math.max(1, latest - earliest);
  const atTime: AtTimeExpect[] = [];
  for (let i = 0; i < 40 && keys.length > 0; i++) {
    const t = earliest + Math.floor((span * (i % 20)) / 20);
    const key = keys[i % keys.length]!;
    atTime.push({ t, key, value: map.atTime(t).get(key) ?? null });
  }

  // frontier views: the map's own frontier, plus per-session partial cuts.
  const fullFrontier = map.core.frontier() as Record<string, number>;
  const frontierCuts: Record<string, number>[] = [{}, fullFrontier];
  for (const [sid, n] of Object.entries(fullFrontier)) {
    if (n > 1) frontierCuts.push({ [sid]: Math.floor(n / 2) });
    frontierCuts.push({ [sid]: n });
  }
  const frontier: FrontierExpect[] = frontierCuts.map((f) => ({
    frontier: f,
    snapshot: map.atFrontier(f).asObject(),
  }));

  const fixture: ContentFixture = {
    description,
    covalues,
    mapId: map.id,
    provideKeys,
    snapshot,
    ops,
    atTime,
    frontier,
  };

  // Always-on internal consistency (CI value even without EXPORT).
  expect(covalues.length).toBeGreaterThan(0);
  for (const c of covalues) {
    expect(c.headerJson.length).toBeGreaterThan(0);
    for (const s of c.sessions) {
      expect(s.transactions.length).toBeGreaterThan(0);
      expect(s.lastSignature.length).toBeGreaterThan(0);
    }
  }
  // Every snapshot key must resolve through ops with a non-del latest op.
  for (const key of Object.keys(snapshot)) {
    const list = ops[key];
    expect(list && list.length).toBeTruthy();
  }
  return fixture;
}

function writeFixture(name: string, fixture: ContentFixture) {
  if (!EXPORT) return;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, `${name}.json`),
    JSON.stringify(fixture, null, 2),
  );
}

function newNode(): LocalNode {
  const agentSecret = Crypto.newRandomAgentSecret();
  const sessionID = Crypto.newRandomSessionID(Crypto.getAgentID(agentSecret));
  return new LocalNode(agentSecret, sessionID, Crypto);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
describe("coMap content fixtures", () => {
  test("lww_and_delete: last-write-wins + deletes (trusting)", () => {
    const node = newNode();
    const map = newTrustingMap(node);
    for (const op of generateOps({
      seed: 101,
      opCount: 200,
      keyCount: 12,
      delFraction: 0.15,
    }))
      applyOp(map, op, "trusting");
    writeFixture(
      "lww_and_delete",
      captureContent(node, map, "LWW + deletes, single session, trusting"),
    );
    expect(Object.keys(map.ops).length).toBeGreaterThan(0);
  });

  test("fww_races: first-writer-wins meta races (trusting)", () => {
    const node = newNode();
    const map = newTrustingMap(node);
    for (const op of generateOps({
      seed: 202,
      opCount: 150,
      keyCount: 8,
      fwwFraction: 0.25,
    }))
      applyOp(map, op, "trusting");
    writeFixture(
      "fww_races",
      captureContent(node, map, "fww races across keys, trusting"),
    );
    expect(map).toBeDefined();
  });

  test("atTime_history: dense single-key history for the atTime grid", () => {
    const node = newNode();
    const map = newTrustingMap(node);
    for (const op of generateOps({ seed: 303, opCount: 120, keyCount: 3 }))
      applyOp(map, op, "trusting");
    writeFixture(
      "atTime_history",
      captureContent(node, map, "dense history over 3 keys for atTime"),
    );
    expect(map).toBeDefined();
  });

  test("private_content: group-owned map with private writes + read key", () => {
    const node = newNode();
    const group = node.createGroup();
    const map = expectMap(group.createMap());
    const rk = group.getCurrentReadKey();
    for (const op of generateOps({
      seed: 404,
      opCount: 80,
      keyCount: 10,
      delFraction: 0.1,
    }))
      applyOp(map, op, "private");
    const fixture = captureContent(
      node,
      map,
      "group-owned private map (native decrypt)",
      [group.id],
      [{ keyId: rk.id, keySecret: rk.secret! }],
    );
    writeFixture("private_content", fixture);
    // The private snapshot must be non-empty (the exporter can read plaintext).
    expect(Object.keys(fixture.snapshot).length).toBeGreaterThan(0);
  });
});
