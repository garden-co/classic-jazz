/**
 * R0 read-boundary benchmark (napi): Rust-resident coMap materialization vs the
 * TS `RawCoMap` baseline, on identical data, warm caches on both sides, fww
 * active, no kill switches. Three boundaries:
 *   (a) per-key FFI accessor        — `NodeCore.mapGet` / `mapGetAt`
 *   (b) bulk snapshot export        — `NodeCore.mapSnapshot`
 *   (c) Rust-resident view + delta  — `DeltaCache` (TS Map patched by mapDelta)
 *
 * Run: node --experimental-strip-types --no-warnings bench/cojson/coMapMaterialization.bench.ts
 */

import cronometro from "cronometro";
import {
  buildRustMap,
  buildTsMap,
  DeltaCache,
  generateOps,
  newRustMap,
  syncRustFromTs,
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
// Shape 1 — 100-key map, 1k ops (5% fww). Hot-get / full iteration / atTime.
// ===========================================================================
const S1_OPS: Op[] = generateOps({
  seed: 42,
  opCount: 1000,
  keyCount: 100,
  fwwFraction: 0.05,
});
const S1_KEYS = [...new Set(S1_OPS.map((o) => o.key))];
// 10k lookup keys cycling over the live key set (identical sequence per side).
const S1_GET_SEQ = Array.from(
  { length: 10000 },
  (_, i) => S1_KEYS[i % S1_KEYS.length]!,
);

let s1_ts: ReturnType<typeof buildTsMap>;
let s1_rust: ReturnType<typeof buildRustMap>;
let s1_cache: DeltaCache;

function s1_before() {
  s1_ts = buildTsMap(S1_OPS);
  s1_rust = buildRustMap(s1_ts);
  s1_cache = new DeltaCache(s1_rust.nc, s1_rust.coId);
  s1_cache.sync();
}

// atTime grid: 1000 (time, key) reads spanning the map's madeAt range.
let S1_AT: { t: number; key: string }[] = [];
function s1_buildAtGrid() {
  const earliest = s1_ts.core.earliestTxMadeAt as number;
  const latest = s1_ts.core.latestTxMadeAt as number;
  const span = Math.max(1, latest - earliest);
  S1_AT = Array.from({ length: 1000 }, (_, i) => ({
    t: earliest + Math.floor((span * (i % 50)) / 50),
    key: S1_KEYS[i % S1_KEYS.length]!,
  }));
}

// ===========================================================================
// Shape 2 — 10k-op single-key map. Latest read x10k.
// ===========================================================================
const S2_OPS: Op[] = generateOps({ seed: 7, opCount: 10000, keyCount: 1 });
let s2_ts: ReturnType<typeof buildTsMap>;
let s2_rust: ReturnType<typeof buildRustMap>;
let s2_cache: DeltaCache;
function s2_before() {
  s2_ts = buildTsMap(S2_OPS);
  s2_rust = buildRustMap(s2_ts);
  s2_cache = new DeltaCache(s2_rust.nc, s2_rust.coId);
  s2_cache.sync();
}

// ===========================================================================
// Shape 3 — write-heavy: 1k ingest batches, one read after each. fww-free so
// the Rust append fast-path and TS incremental processNewTransactions compare
// fairly.
// ===========================================================================
const S3_OPS: Op[] = generateOps({ seed: 13, opCount: 1000, keyCount: 100 });

function s3_ts_baseline() {
  // TS: set + processNewTransactions (implicit in set) + getRaw after each.
  const ts = buildTsMap([]);
  for (const op of S3_OPS) {
    ts.map.set(op.key, (op as any).value, "trusting");
    sink += ts.map.get(op.key) === undefined ? 0 : 1;
  }
}

function s3_boundary_a() {
  const ts = buildTsMap([]);
  const rust = newRustMap(ts);
  for (const op of S3_OPS) {
    ts.map.set(op.key, (op as any).value, "trusting");
    syncRustFromTs(ts, rust); // ingest (append fast-path)
    sink += rust.nc.mapGet(rust.coId, op.key) === null ? 0 : 1;
  }
}

function s3_boundary_c() {
  const ts = buildTsMap([]);
  const rust = newRustMap(ts);
  const cache = new DeltaCache(rust.nc, rust.coId);
  for (const op of S3_OPS) {
    ts.map.set(op.key, (op as any).value, "trusting");
    syncRustFromTs(ts, rust); // ingest (append fast-path)
    cache.sync(); // compact delta patch
    sink += cache.get(op.key) === undefined ? 0 : 1;
  }
}

await cronometro(
  {
    // --- Shape 1: hot-loop single-key get x10k ---
    "S1 hot-get x10k | TS baseline (latest cache)": {
      before: async () => s1_before(),
      test() {
        for (const k of S1_GET_SEQ)
          sink += s1_ts.map.get(k) === undefined ? 0 : 1;
      },
    },
    "S1 hot-get x10k | (a) napi per-key": {
      before: async () => s1_before(),
      test() {
        for (const k of S1_GET_SEQ)
          sink += s1_rust.nc.mapGet(s1_rust.coId, k) === null ? 0 : 1;
      },
    },
    "S1 hot-get x10k | (c) delta-cache": {
      before: async () => s1_before(),
      test() {
        for (const k of S1_GET_SEQ)
          sink += s1_cache.get(k) === undefined ? 0 : 1;
      },
    },

    // --- Shape 1: full iteration (all keys) x100 ---
    "S1 iterate-all x100 | TS baseline (asObject)": {
      before: async () => s1_before(),
      test() {
        for (let i = 0; i < 100; i++)
          sink += Object.keys(s1_ts.map.asObject()).length;
      },
    },
    "S1 iterate-all x100 | (b) napi snapshot": {
      before: async () => s1_before(),
      test() {
        for (let i = 0; i < 100; i++)
          sink += Object.keys(
            JSON.parse(s1_rust.nc.mapSnapshot(s1_rust.coId)),
          ).length;
      },
    },
    "S1 iterate-all x100 | (c) delta-cache": {
      before: async () => s1_before(),
      test() {
        for (let i = 0; i < 100; i++)
          sink += Object.keys(s1_cache.asObject()).length;
      },
    },

    // --- Shape 1: atTime grid x1000 ---
    "S1 atTime x1000 | TS baseline (atTime clone)": {
      before: async () => {
        s1_before();
        s1_buildAtGrid();
      },
      test() {
        for (const { t, key } of S1_AT)
          sink += s1_ts.map.atTime(t).get(key) === undefined ? 0 : 1;
      },
    },
    "S1 atTime x1000 | (a) napi mapGetAt": {
      before: async () => {
        s1_before();
        s1_buildAtGrid();
      },
      test() {
        for (const { t, key } of S1_AT)
          sink += s1_rust.nc.mapGetAt(s1_rust.coId, key, t) === null ? 0 : 1;
      },
    },

    // --- Shape 2: 10k-op single-key latest read x10k ---
    "S2 single-key latest x10k | TS baseline": {
      before: async () => s2_before(),
      test() {
        for (let i = 0; i < 10000; i++)
          sink += s2_ts.map.get("k0") === undefined ? 0 : 1;
      },
    },
    "S2 single-key latest x10k | (a) napi per-key": {
      before: async () => s2_before(),
      test() {
        for (let i = 0; i < 10000; i++)
          sink += s2_rust.nc.mapGet(s2_rust.coId, "k0") === null ? 0 : 1;
      },
    },
    "S2 single-key latest x10k | (c) delta-cache": {
      before: async () => s2_before(),
      test() {
        for (let i = 0; i < 10000; i++)
          sink += s2_cache.get("k0") === undefined ? 0 : 1;
      },
    },

    // --- Shape 3: write-heavy 1k batches, read after each ---
    "S3 write+read x1000 | TS baseline": { test: s3_ts_baseline },
    "S3 write+read x1000 | (a) napi ingest+get": { test: s3_boundary_a },
    "S3 write+read x1000 | (c) ingest+delta+cache": { test: s3_boundary_c },
  },
  benchOptions,
);

if (sink === -1) console.log("unreachable", sink);
