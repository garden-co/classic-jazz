/**
 * Benchmark: fetch (import content) + processing (build view) of a large CoMap.
 *
 * Two workloads, selected via MODE:
 *  - MODE=wide (default): ITEMS distinct keys, each set once.
 *  - MODE=hotkey: a single key set ITEMS times (deep per-key history).
 *
 * Phases measured:
 *  1. create: Node A sets keys locally (exercises the local write path).
 *  2. import: content messages exported and imported on a fresh Node B
 *     (SUBSCRIBED=1 adds a listener that reads the map on every update).
 *  3. read: first full read of the imported map.
 *
 * Run: pnpm exec tsx bench/comap.load.bench.ts [items] [itemsPerTx]
 */
import { WasmCrypto } from "cojson/crypto/WasmCrypto";
import type { RawCoMap } from "cojson";
import { createNode, measureLoad, ms } from "./loadBenchUtils.js";

const ITEMS = Number(process.argv[2] ?? 100_000);
const ITEMS_PER_TX = Number(process.argv[3] ?? 100);
const MODE = (process.env.MODE ?? "wide") as "wide" | "hotkey";
const PRIVACY = (process.env.PRIVACY ?? "private") as "private" | "trusting";
const SUBSCRIBED = Boolean(process.env.SUBSCRIBED);

const crypto = await WasmCrypto.create();

function keyFor(i: number): string {
  return MODE === "hotkey" ? "hot" : `key-${i}`;
}

// --- Node A: create the map -------------------------------------------------
const { node: nodeA, agentSecret } = createNode(crypto);
const group = nodeA.createGroup();

const tCreate0 = performance.now();
const map = group.createMap<RawCoMap<Record<string, string>>>();
for (let i = 0; i < ITEMS; i += ITEMS_PER_TX) {
  if (ITEMS_PER_TX === 1) {
    // Deliberately goes through the public per-set write path
    // (set -> makeTransaction -> processNewTransactions per item)
    map.set(keyFor(i), `value-with-some-payload-${i}`, PRIVACY);
  } else if (MODE === "hotkey") {
    // `assign` collapses duplicate keys, so emit the repeated-set transaction
    // directly to get a genuine multi-op history on one key.
    const changes: { op: "set"; key: string; value: string }[] = [];
    for (let j = i; j < Math.min(i + ITEMS_PER_TX, ITEMS); j++) {
      changes.push({
        op: "set",
        key: keyFor(j),
        value: `value-with-some-payload-${j}`,
      });
    }
    map.core.makeTransaction(changes, PRIVACY);
    map.processNewTransactions();
  } else {
    const batch: Record<string, string> = {};
    for (let j = i; j < Math.min(i + ITEMS_PER_TX, ITEMS); j++) {
      batch[keyFor(j)] = `value-with-some-payload-${j}`;
    }
    map.assign(batch, PRIVACY);
  }
}
const tCreate1 = performance.now();

console.log(
  `create (${MODE}): ${ITEMS} sets in ${Math.ceil(ITEMS / ITEMS_PER_TX)} txs -> ${ms(tCreate1 - tCreate0)}`,
);

// --- Export content messages -------------------------------------------------
const groupContent = nodeA.getCoValue(group.id).newContentSince(undefined)!;
const mapContent = nodeA.getCoValue(map.id).newContentSince(undefined)!;
console.log(
  `content chunks: group=${groupContent.length} map=${mapContent.length}`,
);

// --- Node B: import + read ----------------------------------------------------
async function loadOnFreshNode() {
  const { node: nodeB } = createNode(crypto, agentSecret);

  let listenerReads = 0;
  if (SUBSCRIBED) {
    nodeB.getCoValue(map.id).subscribe((core) => {
      if (core.isAvailable()) {
        (core.getCurrentContent() as RawCoMap).keys();
        listenerReads++;
      }
    }, false);
  }

  const tImport0 = performance.now();
  for (const chunk of groupContent) {
    nodeB.syncManager.handleNewContent(chunk, "import");
  }
  for (const chunk of mapContent) {
    nodeB.syncManager.handleNewContent(chunk, "import");
    if (SUBSCRIBED) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const tImport1 = performance.now();

  const mapB = nodeB.getCoValue(map.id).getCurrentContent() as RawCoMap<
    Record<string, string>
  >;
  const keys = mapB.keys();
  const tRead1 = performance.now();

  const expectedKeys = MODE === "hotkey" ? 1 : ITEMS;
  if (keys.length !== expectedKeys) {
    throw new Error(`expected ${expectedKeys} keys, got ${keys.length}`);
  }

  if (process.env.VERIFY) {
    // The imported view must equal a from-scratch rebuild.
    const before = JSON.stringify(mapB.asObject());
    mapB.rebuildFromCore();
    const after = JSON.stringify(mapB.asObject());
    if (before !== after) {
      throw new Error("imported view diverges from full rebuild");
    }
    if (MODE === "hotkey") {
      const edits = [...mapB.editsAt("hot")];
      if (edits.length !== ITEMS) {
        throw new Error(`expected ${ITEMS} edits, got ${edits.length}`);
      }
      // Edits must be time-ordered.
      for (let i = 1; i < edits.length; i++) {
        if (edits[i]!.at.getTime() < edits[i - 1]!.at.getTime()) {
          throw new Error(`edit history out of order at ${i}`);
        }
      }
      if (mapB.get("hot") !== `value-with-some-payload-${ITEMS - 1}`) {
        throw new Error("hot key does not have the last written value");
      }
    }
  }

  nodeB.gracefulShutdown();

  return {
    import: tImport1 - tImport0,
    read: tRead1 - tImport1,
    total: tRead1 - tImport0,
    listenerReads,
  };
}

await measureLoad(loadOnFreshNode);
