/**
 * R3.5 two-tier transfer GATE benchmark (napi).
 *
 * The R3 stage-2b regression was a COLD/FULL coMap materialization: the RICH
 * per-op delta (`{key: MapOp[]}`, 5 fields per op) transferred over FFI costs
 * more to serialize+parse+apply than the TS `processNewTransactions` walk it
 * replaces (~0.39x INGEST vs main). This bench measures that exact cold-build
 * transfer, comparing three designs on IDENTICAL data:
 *
 *   (a) rich-always     — `mapDeltaRich(id, 0)` → build ops/latest (stage-2b)
 *   (b) cheap + lazy     — `mapDelta(id, 0)` → patch a latest-value cache; the
 *                          per-key `MapOp[]` history is fetched LAZILY via
 *                          `mapOpsForKey` only when a rich accessor touches a
 *                          key (NOT during the cold build) — the R3.5 design
 *   (c) TS baseline      — `RawCoMap.rebuildFromCore()` (full TS materialization
 *                          loop over every valid transaction)
 *
 * Two groups:
 *   1. TRANSFER+APPLY only — native view pre-built once; measures pure
 *      serialize+FFI+parse+TS-apply vs the TS materialization loop. This is the
 *      cleanest isolation of the thing that regressed.
 *   2. FULL COLD INGEST — fresh native node each iteration (create + add +
 *      materialize + transfer + apply), the realistic single-chunk ingest.
 *
 * GATE: the cheap path (b) MUST beat the TS baseline (c) on the cold full
 * materialization before any coMap.ts wiring proceeds.
 *
 * Run: node --experimental-strip-types --no-warnings bench/cojson/coMapTwoTierTransfer.bench.ts
 */

import cronometro from "cronometro";
import { NodeCore as NativeNodeCore } from "cojson-core-napi";
import {
  buildTsMap,
  generateOps,
  type Op,
  type TsMap,
} from "./coMapHarness.ts";

const benchOptions = {
  iterations: 50,
  warmup: true,
  print: { colors: true, compare: true },
  onTestError: (testName: string, error: unknown) => {
    console.error(`\nError in test "${testName}":`);
    console.error(error);
  },
};

let sink = 0;

// ---------------------------------------------------------------------------
// Extract the exact signed transactions of a TS map so the native side replays
// byte-identical data (no re-signing) — the same fairness contract the R0
// harness uses.
// ---------------------------------------------------------------------------
interface Slice {
  sessionID: string;
  txsJson: string;
  sig: string;
}
function extractSlices(ts: TsMap): { header: string; slices: Slice[] } {
  const header = JSON.stringify(ts.core.verified.header);
  const slices: Slice[] = [];
  for (const [sessionID, log] of ts.core.verified.sessionEntries()) {
    if (log.transactions.length === 0) continue;
    slices.push({
      sessionID,
      txsJson: JSON.stringify(log.transactions),
      sig: log.lastSignature,
    });
  }
  return { header, slices };
}

function replayInto(nc: NativeNodeCore, coId: string, slices: Slice[]) {
  for (const s of slices) {
    nc.addTransactions(coId, s.sessionID, undefined, s.txsJson, s.sig, true);
  }
}

type MapOp = {
  txID: { sessionID: string; txIndex: number };
  madeAt: number;
  changeIdx: number;
  change: { op: string; key: string; value?: unknown };
  trusting?: boolean;
};

// TS-side apply of the RICH delta — the work `RawCoMap.consumeNativeDelta` does:
// adopt each key's full MapOp[] into `ops`, set `latest` to the last op.
function applyRich(deltaJson: string): number {
  const delta = JSON.parse(deltaJson) as {
    changedKeys: Record<string, MapOp[]>;
  };
  const ops: Record<string, MapOp[]> = {};
  const latest: Record<string, MapOp | undefined> = {};
  for (const key in delta.changedKeys) {
    const opList = delta.changedKeys[key]!;
    ops[key] = opList;
    latest[key] = opList.length > 0 ? opList[opList.length - 1] : undefined;
  }
  return Object.keys(ops).length;
}

// TS-side apply of the CHEAP delta — patch a latest-value cache (the R0-proven
// boundary c). Serves get/asObject/keys/toJSON.
function applyCheap(deltaJson: string): number {
  const delta = JSON.parse(deltaJson) as {
    changedKeys: Record<string, unknown>;
    deletedKeys: string[];
  };
  const cache = new Map<string, unknown>();
  for (const k in delta.changedKeys) cache.set(k, delta.changedKeys[k]);
  for (const k of delta.deletedKeys) cache.delete(k);
  return cache.size;
}

// ---------------------------------------------------------------------------
// Shapes. "2k ops" per the R3 regression note, in two key distributions.
// ---------------------------------------------------------------------------
type Shape = {
  name: string;
  ops: Op[];
  ts: TsMap;
  header: string;
  slices: Slice[];
  coId: string;
  // Pre-built native view (for the TRANSFER+APPLY-only group).
  nc: NativeNodeCore;
};

function makeShape(name: string, opsSpec: Op[]): Shape {
  const ts = buildTsMap(opsSpec);
  const { header, slices } = extractSlices(ts);
  const coId = ts.coId;
  const nc = new NativeNodeCore();
  nc.createCoValue(coId, header, undefined, true);
  replayInto(nc, coId, slices);
  nc.mapMaterialize(coId, []);
  return { name, ops: opsSpec, ts, header, slices, coId, nc };
}

// Shape A: 2000 ops over 200 keys (~10 ops/key) — deep op history, the rich
// delta's worst case (many ops per changed key).
const SHAPE_A = makeShape(
  "2k ops / 200 keys",
  generateOps({ seed: 101, opCount: 2000, keyCount: 200 }),
);
// Shape B: 2000 ops over 2000 keys (1 op/key) — distinct-key-heavy (rich sends
// one op per key; cheap sends one value per key).
const SHAPE_B = makeShape(
  "2k ops / 2000 keys",
  generateOps({ seed: 202, opCount: 2000, keyCount: 2000 }),
);

const SHAPES = [SHAPE_A, SHAPE_B];

function coldRich(s: Shape): number {
  const nc = new NativeNodeCore();
  nc.createCoValue(s.coId, s.header, undefined, true);
  replayInto(nc, s.coId, s.slices);
  nc.mapMaterialize(s.coId, []);
  return applyRich(nc.mapDeltaRich(s.coId, 0));
}

function coldCheap(s: Shape): number {
  const nc = new NativeNodeCore();
  nc.createCoValue(s.coId, s.header, undefined, true);
  replayInto(nc, s.coId, s.slices);
  nc.mapMaterialize(s.coId, []);
  return applyCheap(nc.mapDelta(s.coId, 0));
}

function coldTs(s: Shape): number {
  s.ts.map.rebuildFromCore();
  return Object.keys(s.ts.map.asObject()).length;
}

const tests: Record<string, { test: () => void }> = {};
for (const s of SHAPES) {
  // --- Group 1: TRANSFER+APPLY only (native view pre-built) ---
  tests[`[${s.name}] transfer | (a) rich-always`] = {
    test() {
      sink += applyRich(s.nc.mapDeltaRich(s.coId, 0));
    },
  };
  tests[`[${s.name}] transfer | (b) cheap+lazy`] = {
    test() {
      sink += applyCheap(s.nc.mapDelta(s.coId, 0));
    },
  };
  tests[`[${s.name}] transfer | (c) TS baseline`] = {
    test() {
      sink += coldTs(s);
    },
  };
  // (d) even-lazier ceiling: transfer NOTHING eagerly; serve a single-key read
  // straight from the Rust view via mapGet. Models the yardstick's real access
  // pattern (ingest N keys, then read ONE) — the eager cheap delta pays O(all
  // keys) it never uses. Assumes the view is already materialized in Rust
  // (which ingestAndMaterialize guarantees).
  tests[`[${s.name}] transfer | (d) lazy value (1 get)`] = {
    test() {
      sink += s.nc.mapGet(s.coId, "k0") === null ? 0 : 1;
    },
  };

  // --- Group 2: FULL COLD INGEST (fresh native node each iteration) ---
  tests[`[${s.name}] cold-ingest | (a) rich-always`] = {
    test() {
      sink += coldRich(s);
    },
  };
  tests[`[${s.name}] cold-ingest | (b) cheap+lazy`] = {
    test() {
      sink += coldCheap(s);
    },
  };
  tests[`[${s.name}] cold-ingest | (c) TS baseline`] = {
    test() {
      sink += coldTs(s);
    },
  };
}

// Sanity: all three designs agree on the live key count for each shape.
for (const s of SHAPES) {
  const rich = applyRich(s.nc.mapDeltaRich(s.coId, 0));
  const cheap = applyCheap(s.nc.mapDelta(s.coId, 0));
  const tsCount = Object.keys(s.ts.map.asObject()).length;
  // rich counts ALL keys (including any deleted), cheap+ts count LIVE keys; with
  // delFraction 0 they coincide. Report if they diverge.
  if (cheap !== tsCount) {
    console.error(
      `MISMATCH [${s.name}] cheap=${cheap} ts=${tsCount} rich=${rich}`,
    );
  } else {
    console.log(
      `ok [${s.name}] live keys: cheap=cheap=${cheap} ts=${tsCount} (rich keys=${rich})`,
    );
  }
}

await cronometro(tests, benchOptions);

if (sink === -1) console.log("unreachable", sink);
