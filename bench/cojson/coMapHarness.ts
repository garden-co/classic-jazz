/**
 * Shared harness for the R0 coMap-materialization benchmark and correctness
 * spot-check.
 *
 * Fairness contract (see spec R0):
 *  - IDENTICAL DATA: the Rust side replays the EXACT transactions the TS
 *    `RawCoMap` produced (extracted verbatim from `core.verified`), so both
 *    materialize the same valid set.
 *  - WARM CACHES: the TS `latest` cache is warmed by `processNewTransactions`
 *    on each write; the Rust view is warmed by `mapMaterialize`. Reads on both
 *    sides then do lookup-only work.
 *  - fww ACTIVE on both: the read datasets include a fraction of fww-keyed
 *    writes (exercised in the one-time materialization, then read many times).
 *    The write-heavy dataset is intentionally fww-free so the Rust incremental
 *    append fast-path (disabled by fww) and the TS incremental
 *    `processNewTransactions` are compared on equal footing.
 *  - NO KILL SWITCHES.
 *
 * The maps use the `unsafeAllowAll` ruleset: every trusting tx is
 * permission-valid on BOTH sides (TS `determineValidTransactions` and the Rust
 * engine alike), which isolates the CONTENT read boundary — the thing R0
 * measures — from permission validation (measured by the prior migration).
 */

import { NodeCore as NativeNodeCore } from "cojson-core-napi";
import { LocalNode } from "cojson";
import { NapiCrypto } from "cojson/crypto/NapiCrypto";

const Crypto = await NapiCrypto.create();

export function newNode(): LocalNode {
  const agentSecret = Crypto.newRandomAgentSecret();
  const sessionID = Crypto.newRandomSessionID(Crypto.getAgentID(agentSecret));
  return new LocalNode(agentSecret, sessionID, Crypto);
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — deterministic datasets across runs and sides.
// ---------------------------------------------------------------------------
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Op =
  | { op: "set"; key: string; value: unknown; fww?: string }
  | { op: "del"; key: string };

/** A random JSON value — strings, numbers, bools, small nested objects. */
function randValue(rng: () => number): unknown {
  const r = rng();
  if (r < 0.4) return Math.floor(rng() * 1e6);
  if (r < 0.7) return `v${Math.floor(rng() * 1e6).toString(36)}`;
  if (r < 0.85) return rng() < 0.5;
  return { a: Math.floor(rng() * 1000), b: `s${Math.floor(rng() * 1000)}` };
}

/**
 * Generate a random op sequence over `keyCount` keys. `fwwFraction` of set-ops
 * carry an fww meta key (drawn from a small pool so writers actually race).
 */
export function generateOps(opts: {
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
    if (fwwFraction > 0 && rng() < fwwFraction) {
      op.fww = `lock${Math.floor(rng() * 8)}`;
    }
    ops.push(op);
  }
  return ops;
}

// ---------------------------------------------------------------------------
// TS baseline: a real RawCoMap in a LocalNode, ops applied as trusting writes.
// ---------------------------------------------------------------------------
export interface TsMap {
  node: LocalNode;
  core: any;
  map: any; // RawCoMap-like: get/asObject/keys/atTime/set/assign/delete
  coId: string;
}

export function newTsMap(node = newNode()): TsMap {
  const core = node.createCoValue({
    type: "comap",
    ruleset: { type: "unsafeAllowAll" },
    meta: null,
    ...Crypto.createdNowUnique(),
  });
  const map = core.getCurrentContent();
  return { node, core, map, coId: core.id };
}

/** Apply one op to the TS map (warms `processNewTransactions` + `latest`). */
export function applyTsOp(ts: TsMap, op: Op): void {
  if (op.op === "del") {
    ts.map.delete(op.key, "trusting");
  } else if (op.fww) {
    // `assign` is the only write path that attaches per-tx meta (for fww).
    ts.map.assign({ [op.key]: op.value }, "trusting", { fww: op.fww });
  } else {
    ts.map.set(op.key, op.value, "trusting");
  }
}

export function buildTsMap(ops: Op[]): TsMap {
  const ts = newTsMap();
  for (const op of ops) applyTsOp(ts, op);
  return ts;
}

// ---------------------------------------------------------------------------
// Rust side: replay the TS map's EXACT transactions into a fresh NativeNodeCore.
// ---------------------------------------------------------------------------
export interface RustMap {
  nc: NativeNodeCore;
  coId: string;
  /** Per-session count of transactions already replayed into the native core. */
  known: Map<string, number>;
}

/** Register `coId` (header only) in a fresh native NodeCore. */
export function newRustMap(ts: TsMap): RustMap {
  const nc = new NativeNodeCore();
  const headerJson = JSON.stringify(ts.core.verified.header);
  nc.createCoValue(ts.coId, headerJson, undefined, true);
  return { nc, coId: ts.coId, known: new Map() };
}

/**
 * Replay any transactions the TS map has that the native core does not yet have
 * (verbatim, per-session slices — `addTransactions` APPENDS), then materialize.
 * Works for both the initial full build and incremental write-then-read loops,
 * guaranteeing byte-identical data on both sides. Returns the new version.
 */
export function syncRustFromTs(ts: TsMap, rust: RustMap): number {
  for (const [sessionID, log] of ts.core.verified.sessionEntries()) {
    const have = rust.known.get(sessionID) ?? 0;
    const total = log.transactions.length;
    if (total <= have) continue;
    const slice = log.transactions.slice(have);
    rust.nc.addTransactions(
      rust.coId,
      sessionID,
      undefined,
      JSON.stringify(slice),
      log.lastSignature,
      true,
    );
    rust.known.set(sessionID, total);
  }
  return rust.nc.mapMaterialize(rust.coId, []);
}

export function buildRustMap(ts: TsMap): RustMap {
  const rust = newRustMap(ts);
  syncRustFromTs(ts, rust);
  return rust;
}

// ---------------------------------------------------------------------------
// R1: PRIVATE data. An owned map (group + map) whose writes are private, so the
// Rust side must decrypt them natively — resolving each tx's `keyUsed` against
// the key store TS feeds via `provideKeySecret`.
// ---------------------------------------------------------------------------
export interface PrivateTsMap extends TsMap {
  group: any;
  readKeyId: string;
  readKeySecret: string;
}

/** A fresh group + owned map; the group's current read key drives private encryption. */
export function newPrivateTsMap(node = newNode()): PrivateTsMap {
  const group = node.createGroup();
  const map = group.createMap();
  const rk = group.getCurrentReadKey();
  return {
    node,
    core: map.core,
    map,
    coId: map.id,
    group,
    readKeyId: rk.id,
    readKeySecret: rk.secret,
  };
}

/** Apply one op as a PRIVATE write (fww is dropped — private fww meta is R2). */
export function applyPrivateOp(pts: PrivateTsMap, op: Op): void {
  if (op.op === "del") pts.map.delete(op.key, "private");
  else pts.map.set(op.key, op.value, "private");
}

export function buildPrivateTsMap(ops: Op[]): PrivateTsMap {
  const pts = newPrivateTsMap();
  for (const op of ops) applyPrivateOp(pts, op);
  return pts;
}

/** Register `core` (header) and replay ALL its sessions verbatim into `nc`. */
function fullReplayCore(nc: NativeNodeCore, core: any): void {
  const headerJson = JSON.stringify(core.verified.header);
  if (!nc.hasCoValue(core.id)) {
    nc.createCoValue(core.id, headerJson, undefined, true);
  }
  for (const [sessionID, log] of core.verified.sessionEntries()) {
    if (log.transactions.length === 0) continue;
    nc.addTransactions(
      core.id,
      sessionID,
      undefined,
      JSON.stringify(log.transactions),
      log.lastSignature,
      true,
    );
  }
}

/**
 * Replay an owned map's data (its owning GROUP first, for permission
 * validation, then the map itself) into a fresh native core. When `provideKey`
 * is set, feed the group's read secret so private txs decrypt; otherwise the
 * private txs are skipped (the key-arrives-late path). Returns the RustMap after
 * an initial `mapMaterialize`.
 */
export function buildRustPrivateMap(
  pts: PrivateTsMap,
  { provideKey = true }: { provideKey?: boolean } = {},
): RustMap {
  const nc = new NativeNodeCore();
  fullReplayCore(nc, pts.group.core);
  fullReplayCore(nc, pts.core);
  if (provideKey) nc.provideKeySecret(pts.readKeyId, pts.readKeySecret);
  nc.mapMaterialize(pts.coId, []);
  return { nc, coId: pts.coId, known: new Map() };
}

// ---------------------------------------------------------------------------
// Part 2: TS-side delta-cache adapter (boundary c).
// A local Map warmed/patched by `mapDelta` after each ingest; reads never cross.
// ---------------------------------------------------------------------------
export class DeltaCache {
  private cache = new Map<string, unknown>();
  private version = 0;
  private readonly nc: NativeNodeCore;
  private readonly coId: string;

  constructor(nc: NativeNodeCore, coId: string) {
    this.nc = nc;
    this.coId = coId;
  }

  /** Pull the compact delta since our cursor and patch the local Map. */
  sync(): void {
    const delta = JSON.parse(this.nc.mapDelta(this.coId, this.version)) as {
      version: number;
      changedKeys: Record<string, unknown>;
      deletedKeys: string[];
    };
    for (const k in delta.changedKeys) this.cache.set(k, delta.changedKeys[k]);
    for (const k of delta.deletedKeys) this.cache.delete(k);
    this.version = delta.version;
  }

  get(key: string): unknown {
    return this.cache.get(key);
  }

  /** Full materialized object from the resident Map (manual loop; the natural
   * way a consumer of a resident cache reads every key). */
  asObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of this.cache) obj[k] = v;
    return obj;
  }

  size(): number {
    return this.cache.size;
  }
}
