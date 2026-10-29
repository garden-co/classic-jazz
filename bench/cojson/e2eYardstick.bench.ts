/**
 * End-to-end performance YARDSTICK for the cojson Rust migration.
 *
 * This suite exercises the cojson PUBLIC API only (whatever `exports.ts`
 * ships: LocalNode, createGroup, group.createMap, map.set/get,
 * node.syncManager.handleNewContent, core.newContentSince, group.roleOf …).
 * Using only the public surface is what makes the SAME file runnable, byte for
 * byte, against both `main` and the migration branch — backward-compat is a
 * hard gate of the migration, so the public API is identical across branches.
 *
 * The companion `yardstick-compare.sh` runs this file in the current worktree
 * and in a fresh `origin/main` worktree, then prints a side-by-side table with
 * multipliers. Those multipliers are the baseline for the standing "≥5x vs
 * main" goal.
 *
 * Run standalone:
 *   node --experimental-strip-types --no-warnings bench/cojson/e2eYardstick.bench.ts
 *
 * Machine-readable mode (used by yardstick-compare.sh):
 *   YARDSTICK_JSON=1 node --experimental-strip-types --no-warnings \
 *     bench/cojson/e2eYardstick.bench.ts
 *   → emits a single JSON line of { shape: { ok, mean_ns, ops_per_sec, ... } }
 *
 * Iteration count is tunable: YARDSTICK_ITERATIONS=<n> (default 20).
 *
 * NOTE: every shape degrades gracefully. If a required method is missing on a
 * branch's public surface (or throws at runtime), the shape is omitted and a
 * `[yardstick] SKIP …` note is printed to stderr — it never aborts the suite.
 */

import cronometro from "cronometro";
import { ControlledAccount, LocalNode, RawCoMap, type RawCoID } from "cojson";
import { NapiCrypto } from "cojson/crypto/NapiCrypto";

// ---------------------------------------------------------------------------
// Shared crypto (NapiCrypto — stable local runner, mirrors groupEngine.bench).
// ---------------------------------------------------------------------------
const Crypto = await NapiCrypto.create();

function newNode(): LocalNode {
  const agentSecret = Crypto.newRandomAgentSecret();
  const sessionID = Crypto.newRandomSessionID(Crypto.getAgentID(agentSecret));
  return new LocalNode(agentSecret, sessionID, Crypto);
}

// A full member account registered on `node`, mirroring the
// `freshAccountInNode` helper in groupEngine.bench.ts. We need *real* account
// covalues for GROUP-HEAVY because role-set values that are account IDs are
// declared as group dependencies and must be ingested by the receiver.
function freshAccountInNode(node: LocalNode): ControlledAccount {
  const acct = (LocalNode as any).internalCreateAccount({
    crypto: node.crypto,
  });
  const entry = node.getCoValue(acct.id);
  const content = acct.core.newContentSince(undefined)?.[0]!;
  node.syncManager.handleNewContent(content, "import");
  return new ControlledAccount(
    entry.getCurrentContent() as any,
    acct.core.node.agentSecret,
  );
}

/** All content pieces of a covalue, exported for re-ingest on another node. */
function exportPieces(coreLike: {
  newContentSince: (s: unknown) => unknown;
}): unknown[] {
  return (coreLike.newContentSince(undefined) as unknown[]) ?? [];
}

/** Ingest a covalue's exported pieces into `target` (group/import peer). */
function ingest(target: LocalNode, pieces: unknown[]): void {
  for (const p of pieces)
    target.syncManager.handleNewContent(p as any, "import");
}

// ---------------------------------------------------------------------------
// Feature detection — gate each shape on the public methods it needs, so a
// branch that lacks (or renamed) something degrades to a skip, not a crash.
// ---------------------------------------------------------------------------
const has = (obj: unknown, key: string): boolean =>
  obj != null && typeof (obj as any)[key] === "function";

const api = {
  localNodeCtor: typeof LocalNode === "function",
  createGroup: has(newNode().constructor.prototype, "createGroup"),
  // createMap / roleOf live on RawGroup.prototype
  createMap: has(RawCoMap.prototype, "set"), // map.set/get checked below
  mapSet: has(RawCoMap.prototype, "set"),
  mapGet: has(RawCoMap.prototype, "get"),
  internalCreateAccount:
    typeof (LocalNode as any).internalCreateAccount === "function",
};

// ---------------------------------------------------------------------------
// Shape parameters (deterministic sizes).
// ---------------------------------------------------------------------------
const INGEST_SMALL = 2000;
const INGEST_LARGE = 10000;
const GROUP_MEMBERS = 50;
const GROUP_ROLE_OPS = 500;
const LOCAL_EDITS = 1000;
const MANY_SMALL_COUNT = 200;
const MANY_SMALL_OPS = 10;
const HOTREAD_KEYS = 100;
const HOTREAD_GETS = 10000;

const ACCOUNT_ROLES = [
  "reader",
  "writer",
  "manager",
  "admin",
  "writeOnly",
] as const;

// Module-level scenario state, populated by each shape's `before()` (runs once
// per test, inside the cronometro worker) and consumed by `test()`.
let ingestSmallSrc: { group: unknown[]; map: unknown[] } | undefined;
let ingestLargeSrc: { group: unknown[]; map: unknown[] } | undefined;
let groupHeavySrc:
  | { memberCores: unknown[][]; group: unknown[]; memberId: string }
  | undefined;
let localEditNode: LocalNode | undefined;
let manySmallSrc:
  | { group: unknown[]; maps: unknown[][]; lastId: RawCoID }
  | undefined;
let hotReadMap: RawCoMap | undefined;
let hotReadSeq: string[] = [];

// ---------------------------------------------------------------------------
// INGEST — build a covalue with N map ops on node A (public writes), export
// via newContentSince, then measure ingest + first read on a FRESH node B
// (the sync-receive pipeline: validation + materialization).
// ---------------------------------------------------------------------------
function buildIngestSource(opCount: number): {
  group: unknown[];
  map: unknown[];
} {
  const node = newNode();
  const group = node.createGroup();
  const map = group.createMap();
  for (let i = 0; i < opCount; i++) {
    map.set(`k${i}`, `v${i}`, "trusting");
  }
  return { group: exportPieces(group.core), map: exportPieces(map.core) };
}

// ---------------------------------------------------------------------------
// GROUP-HEAVY — a group with 50 members and 500 role ops; measure full load
// into a fresh node + a roleOf read via the public accessor.
// ---------------------------------------------------------------------------
function buildGroupHeavySource(): {
  memberCores: unknown[][];
  group: unknown[];
  memberId: string;
} {
  const node = newNode();
  const group = node.createGroup();
  const memberCores: unknown[][] = [];
  const memberIds: string[] = [];
  for (let i = 0; i < GROUP_MEMBERS; i++) {
    const m = freshAccountInNode(node);
    memberIds.push(m.id);
    memberCores.push(exportPieces(node.getCoValue(m.id as RawCoID)));
  }
  // 500 role ops cycling over the SAME 50 member account ids. Using real
  // account ids as role keys is what makes the group declare them as
  // dependencies (so the receiver ingests all 50 account cores) — this is the
  // realistic "full load" cost and keeps roleOf resolution meaningful.
  for (let i = 0; i < GROUP_ROLE_OPS; i++) {
    (group.set as any)(
      memberIds[i % GROUP_MEMBERS],
      ACCOUNT_ROLES[i % ACCOUNT_ROLES.length],
      "trusting",
    );
  }
  return {
    memberCores,
    group: exportPieces(group.core),
    memberId: memberIds[0]!,
  };
}

// ---------------------------------------------------------------------------
// LOCAL-EDIT — 1,000 sequential map.set calls with a get after each (local
// write pipeline: tx + processNewTransactions + materialize + read).
// ---------------------------------------------------------------------------
function runLocalEdit(node: LocalNode): void {
  const group = node.createGroup();
  const map = group.createMap();
  for (let i = 0; i < LOCAL_EDITS; i++) {
    const k = `k${i}`;
    map.set(k, `v${i}`, "trusting");
    map.get(k);
  }
}

// ---------------------------------------------------------------------------
// MANY-SMALL — create 200 small covalues (10 ops each) under one group on
// node A, ingest the whole set into a fresh node.
// ---------------------------------------------------------------------------
function buildManySmallSource(): {
  group: unknown[];
  maps: unknown[][];
  lastId: RawCoID;
} {
  const node = newNode();
  const group = node.createGroup();
  const maps: unknown[][] = [];
  let lastId = "" as RawCoID;
  for (let i = 0; i < MANY_SMALL_COUNT; i++) {
    const m = group.createMap();
    for (let j = 0; j < MANY_SMALL_OPS; j++) {
      m.set(`k${j}`, `v${j}`, "trusting");
    }
    lastId = m.id;
    maps.push(exportPieces(m.core));
  }
  return { group: exportPieces(group.core), maps, lastId };
}

function runManySmall(src: {
  group: unknown[];
  maps: unknown[][];
  lastId: RawCoID;
}): void {
  const nodeB = newNode();
  ingest(nodeB, src.group);
  for (const pieces of src.maps) ingest(nodeB, pieces);
  (nodeB.getCoValue(src.lastId).getCurrentContent() as RawCoMap).get("k0");
}

// ---------------------------------------------------------------------------
// HOT-READ — ceiling documentation: 10k repeated map.get on a warm 100-key map.
// ---------------------------------------------------------------------------
function buildHotReadMap(): RawCoMap {
  const node = newNode();
  const group = node.createGroup();
  const map = group.createMap();
  for (let i = 0; i < HOTREAD_KEYS; i++) {
    map.set(`k${i}`, `v${i}`, "trusting");
  }
  return map;
}

// ---------------------------------------------------------------------------
// Assemble the suite, degrading any shape whose API is unavailable.
// ---------------------------------------------------------------------------
const skips: string[] = [];
const suite: Record<
  string,
  { before?: () => Promise<void>; test: () => void }
> = {};

if (api.localNodeCtor && api.createGroup && api.mapSet && api.mapGet) {
  suite[`INGEST 2k ops → fresh node (sync-receive)`] = {
    async before() {
      ingestSmallSrc = buildIngestSource(INGEST_SMALL);
    },
    test() {
      const src = ingestSmallSrc!;
      const nodeB = newNode();
      ingest(nodeB, src.group);
      const mapId = (src.map[0] as any)?.id as RawCoID;
      ingest(nodeB, src.map);
      (nodeB.getCoValue(mapId).getCurrentContent() as RawCoMap).get("k0");
    },
  };

  suite[`INGEST 10k ops → fresh node (sync-receive)`] = {
    async before() {
      ingestLargeSrc = buildIngestSource(INGEST_LARGE);
    },
    test() {
      const src = ingestLargeSrc!;
      const nodeB = newNode();
      ingest(nodeB, src.group);
      const mapId = (src.map[0] as any)?.id as RawCoID;
      ingest(nodeB, src.map);
      (nodeB.getCoValue(mapId).getCurrentContent() as RawCoMap).get("k0");
    },
  };

  suite[`LOCAL-EDIT 1k set+get (local write pipeline)`] = {
    async before() {
      localEditNode = newNode();
    },
    test() {
      runLocalEdit(localEditNode!);
    },
  };

  suite[`MANY-SMALL 200×10 → fresh node (sync-receive)`] = {
    async before() {
      manySmallSrc = buildManySmallSource();
    },
    test() {
      runManySmall(manySmallSrc!);
    },
  };

  suite[`HOT-READ 10k get on warm 100-key map (ceiling)`] = {
    async before() {
      hotReadMap = buildHotReadMap();
      hotReadSeq = Array.from(
        { length: HOTREAD_GETS },
        (_, i) => `k${i % HOTREAD_KEYS}`,
      );
    },
    test() {
      const m = hotReadMap!;
      for (let i = 0; i < HOTREAD_GETS; i++) m.get(hotReadSeq[i]!);
    },
  };
} else {
  skips.push(
    `core map API unavailable (createGroup=${api.createGroup}, mapSet=${api.mapSet}, mapGet=${api.mapGet}) — skipping map shapes`,
  );
}

if (api.localNodeCtor && api.internalCreateAccount && api.createGroup) {
  suite[`GROUP-HEAVY 50 members/500 ops → fresh node + roleOf`] = {
    async before() {
      groupHeavySrc = buildGroupHeavySource();
    },
    test() {
      const src = groupHeavySrc!;
      const nodeB = newNode();
      for (const pieces of src.memberCores) ingest(nodeB, pieces);
      const groupId = (src.group[0] as any)?.id as RawCoID;
      ingest(nodeB, src.group);
      const g = nodeB.getCoValue(groupId).getCurrentContent() as any;
      g.roleOf(src.memberId);
    },
  };
} else {
  skips.push(
    `GROUP-HEAVY unavailable (internalCreateAccount=${api.internalCreateAccount}) — skipping`,
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const iterations =
  Number.parseInt(process.env.YARDSTICK_ITERATIONS ?? "", 10) || 20;
const errorThreshold =
  Number.parseInt(process.env.YARDSTICK_ERROR_THRESHOLD ?? "", 10) || 5;
const wantJson = process.env.YARDSTICK_JSON === "1";

for (const note of skips) console.error(`[yardstick] SKIP ${note}`);

const benchOptions = {
  iterations,
  warmup: true,
  errorThreshold,
  print: wantJson ? false : { colors: true, compare: true },
  onTestError: (testName: string, error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[yardstick] TEST ERROR "${testName}": ${msg}`);
  },
};

const results = await cronometro(suite as any, benchOptions as any);

// In worker threads `cronometro` returns undefined; the emit below is
// main-thread only.
if (results) {
  if (wantJson) {
    const summary: Record<string, unknown> = {};
    for (const [name, r] of Object.entries(results as any)) {
      const res = r as any;
      summary[name] = res?.success
        ? {
            ok: true,
            mean_ns: res.mean,
            ops_per_sec: res.mean ? 1e9 / res.mean : 0,
            se_ns: res.standardError,
            iterations: res.size,
          }
        : {
            ok: false,
            error: String(res?.error?.message ?? res?.error ?? "failed"),
          };
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }
  // Ensure a clean exit regardless of any timers the nodes spun up.
  process.exit(0);
}
