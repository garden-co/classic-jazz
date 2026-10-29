/**
 * R1 read-boundary benchmark addendum (napi): the R0 read shapes re-run on
 * PRIVATE data. The Rust side now DECRYPTS each private tx natively (once,
 * during `mapMaterialize`, resolving `keyUsed` against the key store); reads
 * then hit the already-materialized view. The thesis to confirm: decrypt-once +
 * cached reads hold the R0 wins — the per-read boundaries (a hot-get, b
 * snapshot, c delta-cache) stay at parity with (or ahead of) the TS `RawCoMap`,
 * which likewise decrypts once and reads from its `latest` cache.
 *
 * Baseline fairness mirrors R0: identical data on both sides (the Rust core
 * replays the owning group + the map's exact private transactions), warm caches
 * (TS `processNewTransactions`, Rust `mapMaterialize`), no kill switches.
 *
 * Run: node --experimental-strip-types --no-warnings bench/cojson/coMapMaterialization.private.bench.ts
 */

import cronometro from "cronometro";
import {
  buildPrivateTsMap,
  buildRustPrivateMap,
  DeltaCache,
  generateOps,
  type Op,
} from "./coMapHarness.ts";

const benchOptions = {
  iterations: 30,
  warmup: true,
  print: { colors: true, compare: true },
  onTestError: (testName: string, error: unknown) => {
    console.error(`\nError in test "${testName}":`);
    console.error(error);
  },
};

let sink = 0;

// ===========================================================================
// Shape 1 — 100-key PRIVATE map, 1k ops. Hot-get x10k / full iteration x100.
// ===========================================================================
const P1_OPS: Op[] = generateOps({ seed: 42, opCount: 1000, keyCount: 100 });
const P1_KEYS = [...new Set(P1_OPS.map((o) => o.key))];
const P1_GET_SEQ = Array.from(
  { length: 10000 },
  (_, i) => P1_KEYS[i % P1_KEYS.length]!,
);

let p1_ts: ReturnType<typeof buildPrivateTsMap>;
let p1_rust: ReturnType<typeof buildRustPrivateMap>;
let p1_cache: DeltaCache;

function p1_before() {
  p1_ts = buildPrivateTsMap(P1_OPS);
  p1_rust = buildRustPrivateMap(p1_ts);
  p1_cache = new DeltaCache(p1_rust.nc, p1_rust.coId);
  p1_cache.sync();
}

// ===========================================================================
// Shape 2 — PRIVATE single-key churn (2k ops). Latest read x10k.
// (Kept below R0's 10k op count because each op is an encrypt on the TS build
// side; the read workload — 10k lookups — matches R0.)
// ===========================================================================
const P2_OPS: Op[] = generateOps({ seed: 7, opCount: 2000, keyCount: 1 });
let p2_ts: ReturnType<typeof buildPrivateTsMap>;
let p2_rust: ReturnType<typeof buildRustPrivateMap>;
let p2_cache: DeltaCache;
function p2_before() {
  p2_ts = buildPrivateTsMap(P2_OPS);
  p2_rust = buildRustPrivateMap(p2_ts);
  p2_cache = new DeltaCache(p2_rust.nc, p2_rust.coId);
  p2_cache.sync();
}

await cronometro(
  {
    // --- Shape 1: hot-loop single-key get x10k (private, decrypted-once) ---
    "P1 hot-get x10k | TS baseline (latest cache)": {
      before: async () => p1_before(),
      test() {
        for (const k of P1_GET_SEQ)
          sink += p1_ts.map.get(k) === undefined ? 0 : 1;
      },
    },
    "P1 hot-get x10k | (a) napi per-key": {
      before: async () => p1_before(),
      test() {
        for (const k of P1_GET_SEQ)
          sink += p1_rust.nc.mapGet(p1_rust.coId, k) === null ? 0 : 1;
      },
    },
    "P1 hot-get x10k | (c) delta-cache": {
      before: async () => p1_before(),
      test() {
        for (const k of P1_GET_SEQ)
          sink += p1_cache.get(k) === undefined ? 0 : 1;
      },
    },

    // --- Shape 1: full iteration (all keys) x100 ---
    "P1 iterate-all x100 | TS baseline (asObject)": {
      before: async () => p1_before(),
      test() {
        for (let i = 0; i < 100; i++)
          sink += Object.keys(p1_ts.map.asObject()).length;
      },
    },
    "P1 iterate-all x100 | (b) napi snapshot": {
      before: async () => p1_before(),
      test() {
        for (let i = 0; i < 100; i++)
          sink += Object.keys(
            JSON.parse(p1_rust.nc.mapSnapshot(p1_rust.coId)),
          ).length;
      },
    },
    "P1 iterate-all x100 | (c) delta-cache": {
      before: async () => p1_before(),
      test() {
        for (let i = 0; i < 100; i++)
          sink += Object.keys(p1_cache.asObject()).length;
      },
    },

    // --- Shape 2: single-key latest read x10k (private, decrypted-once) ---
    "P2 single-key latest x10k | TS baseline": {
      before: async () => p2_before(),
      test() {
        for (let i = 0; i < 10000; i++)
          sink += p2_ts.map.get("k0") === undefined ? 0 : 1;
      },
    },
    "P2 single-key latest x10k | (a) napi per-key": {
      before: async () => p2_before(),
      test() {
        for (let i = 0; i < 10000; i++)
          sink += p2_rust.nc.mapGet(p2_rust.coId, "k0") === null ? 0 : 1;
      },
    },
    "P2 single-key latest x10k | (c) delta-cache": {
      before: async () => p2_before(),
      test() {
        for (let i = 0; i < 10000; i++)
          sink += p2_cache.get("k0") === undefined ? 0 : 1;
      },
    },
  },
  benchOptions,
);

if (sink === -1) console.log("unreachable", sink);
