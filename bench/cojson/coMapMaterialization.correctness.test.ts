/**
 * R0 correctness spot-check: the Rust coMap materialization must produce
 * BYTE-EQUAL views to the TS `RawCoMap` on the same data, or the benchmark
 * comparison is meaningless. ~20 seeded randomized scenarios covering
 * last-write-wins, deletes, fww races, and atTime history queries, across all
 * three read boundaries (get / snapshot / delta-cache).
 *
 * Run: pnpm --filter jazz-tools-benchmark exec vitest run coMapMaterialization.correctness
 */

import { describe, expect, test } from "vitest";
import {
  buildPrivateTsMap,
  buildRustMap,
  buildRustPrivateMap,
  buildTsMap,
  DeltaCache,
  generateOps,
  newPrivateTsMap,
  newRustMap,
  syncRustFromTs,
  type Op,
} from "./coMapHarness.ts";

/** Normalize `undefined` (TS absent) to `null` (Rust absent) for comparison. */
function norm(v: unknown): unknown {
  return v === undefined ? null : v;
}

function rustGet(rust: { nc: any; coId: string }, key: string): unknown {
  const s = rust.nc.mapGet(rust.coId, key);
  return s === null ? null : JSON.parse(s);
}

function rustGetAt(
  rust: { nc: any; coId: string },
  key: string,
  atTime?: number,
): unknown {
  const s = rust.nc.mapGetAt(rust.coId, key, atTime ?? undefined);
  return s === null ? null : JSON.parse(s);
}

const SCENARIOS: {
  name: string;
  opCount: number;
  keyCount: number;
  fwwFraction?: number;
  delFraction?: number;
}[] = [
  { name: "small dense", opCount: 50, keyCount: 5 },
  { name: "wide sparse", opCount: 500, keyCount: 200 },
  { name: "single key churn", opCount: 300, keyCount: 1 },
  { name: "with deletes", opCount: 400, keyCount: 30, delFraction: 0.25 },
  { name: "fww races", opCount: 300, keyCount: 40, fwwFraction: 0.3 },
  {
    name: "fww + deletes",
    opCount: 400,
    keyCount: 40,
    fwwFraction: 0.2,
    delFraction: 0.2,
  },
  { name: "heavy fww", opCount: 600, keyCount: 50, fwwFraction: 0.5 },
  {
    name: "100-key realistic",
    opCount: 1000,
    keyCount: 100,
    fwwFraction: 0.05,
  },
];

describe("Rust coMap materialization matches TS RawCoMap", () => {
  // 20 scenarios: each shape run under a few seeds.
  const cases: {
    label: string;
    seed: number;
    cfg: (typeof SCENARIOS)[number];
  }[] = [];
  let seed = 1;
  for (const cfg of SCENARIOS) {
    const seeds = cfg.name === "100-key realistic" ? 1 : 3;
    for (let s = 0; s < seeds; s++) {
      cases.push({ label: `${cfg.name} #${s}`, seed: seed++, cfg });
    }
  }

  test.each(cases)("$label", ({ seed, cfg }) => {
    const ops: Op[] = generateOps({ seed, ...cfg });
    const ts = buildTsMap(ops);
    const rust = buildRustMap(ts);

    // (b) snapshot: whole materialized map must be deep-equal.
    const tsObject = ts.map.asObject();
    const rustSnapshot = JSON.parse(rust.nc.mapSnapshot(rust.coId));
    expect(rustSnapshot).toEqual(tsObject);

    // (a) per-key get: every key the TS map knows about must agree, plus a
    // couple of never-written keys (absent on both).
    const keys = [...new Set(ops.map((o) => o.key)), "k_never", "zzz"];
    for (const key of keys) {
      expect(norm(rustGet(rust, key))).toEqual(norm(ts.map.get(key)));
    }

    // (c) delta-cache: after a full sync, the local Map mirrors the snapshot.
    const cache = new DeltaCache(rust.nc, rust.coId);
    cache.sync();
    expect(cache.asObject()).toEqual(tsObject);

    // atTime grid: sample times across the map's madeAt range; every key must
    // agree at every sampled time (TS clone.get vs Rust map_get_at).
    const earliest = ts.core.earliestTxMadeAt as number;
    const latest = ts.core.latestTxMadeAt as number;
    const times = [
      earliest - 1,
      earliest,
      Math.floor((earliest + latest) / 2),
      latest,
    ];
    for (const t of times) {
      const tsAt = ts.map.atTime(t);
      for (const key of keys) {
        expect(norm(rustGetAt(rust, key, t))).toEqual(norm(tsAt.get(key)));
      }
    }
  });

  test("incremental append (write-then-read loop) stays consistent", () => {
    // Mirrors the write-heavy shape: ingest one op at a time, materialize, and
    // check the Rust view + delta-cache track TS after every batch.
    const ops = generateOps({ seed: 999, opCount: 200, keyCount: 30 });
    const ts = buildTsMap([]);
    const rust = newRustMap(ts);
    const cache = new DeltaCache(rust.nc, rust.coId);

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (op.op === "del") ts.map.delete(op.key, "trusting");
      else ts.map.set(op.key, op.value, "trusting");

      // Replay only the new transactions into the native core, then refresh.
      syncRustFromTs(ts, rust);
      cache.sync();

      if (i % 25 === 0 || i === ops.length - 1) {
        expect(JSON.parse(rust.nc.mapSnapshot(rust.coId))).toEqual(
          ts.map.asObject(),
        );
        expect(cache.asObject()).toEqual(ts.map.asObject());
      }
    }
  });
});

/**
 * R1: the same equality bar, but on PRIVATE data — the Rust side must DECRYPT
 * each private tx natively (resolving `keyUsed` against the key store TS feeds)
 * to reproduce the TS `RawCoMap`. Covers all-private, mixed private/trusting,
 * and the key-arrives-late retry.
 */
describe("Rust coMap materialization matches TS RawCoMap on PRIVATE data", () => {
  const PRIV_SHAPES: {
    name: string;
    opCount: number;
    keyCount: number;
    delFraction?: number;
  }[] = [
    { name: "private small dense", opCount: 40, keyCount: 5 },
    { name: "private wide sparse", opCount: 200, keyCount: 60 },
    { name: "private single-key churn", opCount: 120, keyCount: 1 },
    {
      name: "private with deletes",
      opCount: 150,
      keyCount: 20,
      delFraction: 0.25,
    },
  ];

  const cases: {
    label: string;
    seed: number;
    cfg: (typeof PRIV_SHAPES)[number];
  }[] = [];
  let seed = 500;
  for (const cfg of PRIV_SHAPES) {
    for (let s = 0; s < 2; s++) {
      cases.push({ label: `${cfg.name} #${s}`, seed: seed++, cfg });
    }
  }

  test.each(cases)("$label", ({ seed, cfg }) => {
    const ops: Op[] = generateOps({ seed, ...cfg }); // fwwFraction 0 (private)
    const pts = buildPrivateTsMap(ops);
    const rust = buildRustPrivateMap(pts);

    const tsObject = pts.map.asObject();
    expect(JSON.parse(rust.nc.mapSnapshot(rust.coId))).toEqual(tsObject);

    const keys = [...new Set(ops.map((o) => o.key)), "k_never"];
    for (const key of keys) {
      expect(norm(rustGet(rust, key))).toEqual(norm(pts.map.get(key)));
    }

    // Every private tx decrypted -> nothing outstanding.
    expect(rust.nc.missingKeyIds(rust.coId)).toEqual([]);
  });

  test("mixed private + trusting writes materialize identically", () => {
    const ops = generateOps({ seed: 700, opCount: 200, keyCount: 25 });
    const pts = newPrivateTsMap();
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      const privacy = i % 2 === 0 ? "private" : "trusting";
      if (op.op === "del") pts.map.delete(op.key, privacy);
      else pts.map.set(op.key, op.value, privacy);
    }
    const rust = buildRustPrivateMap(pts);
    expect(JSON.parse(rust.nc.mapSnapshot(rust.coId))).toEqual(
      pts.map.asObject(),
    );
    expect(rust.nc.missingKeyIds(rust.coId)).toEqual([]);
  });

  test("key arrives late: private txs skipped, then rebuilt after provideKeySecret", () => {
    const ops = generateOps({ seed: 800, opCount: 60, keyCount: 10 });
    const pts = buildPrivateTsMap(ops);

    // Build WITHOUT the key: private txs must be skipped, their keyUsed recorded.
    const rust = buildRustPrivateMap(pts, { provideKey: false });
    expect(JSON.parse(rust.nc.mapSnapshot(rust.coId))).toEqual({});
    expect(rust.nc.missingKeyIds(rust.coId)).toContain(pts.readKeyId);
    const before = rust.nc.mapMaterialize(rust.coId, []); // cache hit (no key yet)

    // Key arrives -> keys-version bump -> next materialize rebuilds (no new txs).
    rust.nc.provideKeySecret(pts.readKeyId, pts.readKeySecret);
    const after = rust.nc.mapMaterialize(rust.coId, []);
    expect(after).toBeGreaterThan(before);
    expect(JSON.parse(rust.nc.mapSnapshot(rust.coId))).toEqual(
      pts.map.asObject(),
    );
    expect(rust.nc.missingKeyIds(rust.coId)).toEqual([]);
  });
});
