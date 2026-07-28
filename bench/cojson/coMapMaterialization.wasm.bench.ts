/**
 * R0 read-boundary benchmark (wasm): the same coMap materialization measured
 * against the TS `RawCoMap` baseline, but through the wasm binding — the one the
 * browser actually uses. Node-side wasm run via the `cojson-core-wasm` package
 * (acceptable per spec; caveat: a real browser adds no Node FFI thunk but the
 * wasm<->JS boundary + JSON marshaling cost measured here is representative).
 *
 * Replicates the hot-loop get and full-iteration shapes (the two the spec
 * requires on wasm). Boundaries measured: (a) per-key `mapGet`, (b) bulk
 * `mapSnapshot`. Boundary (c) is the same TS-side DeltaCache Map as on napi
 * (its reads never cross the boundary), so it is not re-measured here.
 *
 * Run: node --experimental-strip-types --no-warnings bench/cojson/coMapMaterialization.wasm.bench.ts
 */

import cronometro from "cronometro";
import { NodeCore as WasmNodeCore, initialize } from "cojson-core-wasm";
import {
  buildTsMap,
  DeltaCache,
  generateOps,
  type Op,
} from "./coMapHarness.ts";

await initialize();

/** Replay a TS map's transactions into a fresh wasm NodeCore and materialize. */
function buildWasmMap(ts: ReturnType<typeof buildTsMap>) {
  const nc = new WasmNodeCore();
  nc.createCoValue(
    ts.coId,
    JSON.stringify(ts.core.verified.header),
    undefined,
    true,
  );
  for (const [sessionID, log] of ts.core.verified.sessionEntries()) {
    nc.addTransactions(
      ts.coId,
      sessionID,
      undefined,
      JSON.stringify(log.transactions),
      log.lastSignature,
      true,
    );
  }
  nc.mapMaterialize(ts.coId, []);
  return { nc, coId: ts.coId };
}

let sink = 0;

// 100-key map, 1k ops (5% fww) — same shape as napi S1.
const OPS: Op[] = generateOps({
  seed: 42,
  opCount: 1000,
  keyCount: 100,
  fwwFraction: 0.05,
});
const KEYS = [...new Set(OPS.map((o) => o.key))];
const GET_SEQ = Array.from({ length: 10000 }, (_, i) => KEYS[i % KEYS.length]!);

let ts: ReturnType<typeof buildTsMap>;
let wasm: ReturnType<typeof buildWasmMap>;
let cache: DeltaCache;

// Sanity: wasm view must equal the TS view before we trust any timing.
{
  ts = buildTsMap(OPS);
  wasm = buildWasmMap(ts);
  const a = JSON.stringify(ts.map.asObject());
  const b = JSON.parse(wasm.nc.mapSnapshot(wasm.coId));
  if (a !== JSON.stringify(b)) {
    // Deep-ish check (key order may differ); fall back to per-key.
    const tsObj = ts.map.asObject();
    for (const k of KEYS) {
      const bv = wasm.nc.mapGet(wasm.coId, k);
      const tv = tsObj[k];
      if (
        (bv === undefined ? undefined : JSON.stringify(JSON.parse(bv))) !==
        (tv === undefined ? undefined : JSON.stringify(tv))
      ) {
        throw new Error(
          `wasm/TS mismatch on key ${k}: ${bv} vs ${JSON.stringify(tv)}`,
        );
      }
    }
  }
}

function before() {
  ts = buildTsMap(OPS);
  wasm = buildWasmMap(ts);
  // (c) delta-cache over the wasm core: reads hit this TS Map, never crossing
  // the wasm boundary (the whole point of the delta design).
  cache = new DeltaCache(wasm.nc as any, wasm.coId);
  cache.sync();
}

await cronometro(
  {
    "WASM hot-get x10k | TS baseline (latest cache)": {
      before: async () => before(),
      test() {
        for (const k of GET_SEQ) sink += ts.map.get(k) === undefined ? 0 : 1;
      },
    },
    "WASM hot-get x10k | (a) wasm per-key": {
      before: async () => before(),
      test() {
        for (const k of GET_SEQ)
          sink += wasm.nc.mapGet(wasm.coId, k) === undefined ? 0 : 1;
      },
    },
    "WASM hot-get x10k | (c) delta-cache (TS-side, no crossing)": {
      before: async () => before(),
      test() {
        for (const k of GET_SEQ) sink += cache.get(k) === undefined ? 0 : 1;
      },
    },
    "WASM iterate-all x100 | TS baseline (asObject)": {
      before: async () => before(),
      test() {
        for (let i = 0; i < 100; i++)
          sink += Object.keys(ts.map.asObject()).length;
      },
    },
    "WASM iterate-all x100 | (b) wasm snapshot": {
      before: async () => before(),
      test() {
        for (let i = 0; i < 100; i++)
          sink += Object.keys(
            JSON.parse(wasm.nc.mapSnapshot(wasm.coId)),
          ).length;
      },
    },
    "WASM iterate-all x100 | (c) delta-cache (TS-side, no crossing)": {
      before: async () => before(),
      test() {
        for (let i = 0; i < 100; i++)
          sink += Object.keys(cache.asObject()).length;
      },
    },
  },
  {
    iterations: 30,
    warmup: true,
    print: { colors: true, compare: true },
    onTestError: (n: string, e: unknown) =>
      console.error(`\nError in "${n}":`, e),
  },
);

if (sink === -1) console.log("unreachable", sink);
