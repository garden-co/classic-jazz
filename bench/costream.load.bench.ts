/**
 * Benchmark: fetch (import content) + processing (build view) of CoStreams.
 *
 * Two workloads, selected via MODE:
 *  - MODE=stream (default): a RawCoStream with ITEMS pushed values
 *    (one tx each, single session).
 *  - MODE=binary: a RawBinaryCoStream file of ITEMS chunks x CHUNK_KB.
 *    SUBSCRIBED=1 mimics download-progress polling: the listener calls
 *    getBinaryChunks(allowUnfinished) on every update.
 *
 * Run: pnpm exec tsx bench/costream.load.bench.ts [items] [chunkKB]
 */
import { WasmCrypto } from "cojson/crypto/WasmCrypto";
import type { RawBinaryCoStream, RawCoStream } from "cojson";
import { createNode, measureLoad, ms } from "./loadBenchUtils.js";

const MODE = (process.env.MODE ?? "stream") as "stream" | "binary";
const ITEMS = Number(process.argv[2] ?? (MODE === "binary" ? 100 : 20_000));
const CHUNK_KB = Number(process.argv[3] ?? 100);
const PRIVACY = (process.env.PRIVACY ?? "private") as "private" | "trusting";
const SUBSCRIBED = Boolean(process.env.SUBSCRIBED);

const crypto = await WasmCrypto.create();

// --- Node A: create the stream ------------------------------------------------
const { node: nodeA, agentSecret } = createNode(crypto);
const group = nodeA.createGroup();

let streamID: string;
let originalBytes: Uint8Array | undefined;

const tCreate0 = performance.now();
if (MODE === "binary") {
  const stream = group.createBinaryStream();
  streamID = stream.id;
  stream.startBinaryStream({ mimeType: "application/octet-stream" }, PRIVACY);
  originalBytes = new Uint8Array(ITEMS * CHUNK_KB * 1024);
  for (let i = 0; i < originalBytes.length; i++) {
    originalBytes[i] = (i * 31 + 7) & 0xff;
  }
  for (let i = 0; i < ITEMS; i++) {
    stream.pushBinaryStreamChunk(
      originalBytes.subarray(i * CHUNK_KB * 1024, (i + 1) * CHUNK_KB * 1024),
      PRIVACY,
    );
  }
  stream.endBinaryStream(PRIVACY);
} else {
  const stream = group.createStream<RawCoStream<string>>();
  streamID = stream.id;
  for (let i = 0; i < ITEMS; i++) {
    stream.push(`item-with-some-payload-${i}`, PRIVACY);
  }
}
const tCreate1 = performance.now();

console.log(
  `create (${MODE}): ${ITEMS} ${MODE === "binary" ? `chunks x ${CHUNK_KB}KB` : "pushes"} -> ${ms(tCreate1 - tCreate0)}`,
);

// --- Export content messages ---------------------------------------------------
const groupContent = nodeA.getCoValue(group.id).newContentSince(undefined)!;
const streamContent = nodeA
  .getCoValue(streamID as any)
  .newContentSince(undefined)!;
console.log(
  `content chunks: group=${groupContent.length} stream=${streamContent.length}`,
);

// --- Node B: import + read ------------------------------------------------------
async function loadOnFreshNode() {
  const { node: nodeB } = createNode(crypto, agentSecret);

  let listenerReads = 0;
  if (SUBSCRIBED) {
    nodeB.getCoValue(streamID as any).subscribe((core) => {
      if (core.isAvailable()) {
        const content = core.getCurrentContent();
        if (MODE === "binary") {
          (content as RawBinaryCoStream).getBinaryChunks(true);
        } else {
          (content as RawCoStream).sessions();
        }
        listenerReads++;
      }
    }, false);
  }

  const tImport0 = performance.now();
  for (const chunk of groupContent) {
    nodeB.syncManager.handleNewContent(chunk, "import");
  }
  for (const chunk of streamContent) {
    nodeB.syncManager.handleNewContent(chunk, "import");
    if (SUBSCRIBED) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const tImport1 = performance.now();

  const contentB = nodeB.getCoValue(streamID as any).getCurrentContent();
  let tRead1: number;

  if (MODE === "binary") {
    const streamB = contentB as RawBinaryCoStream;
    const result = streamB.getBinaryChunks(false);
    tRead1 = performance.now();

    if (!result || !result.finished) {
      throw new Error("expected finished binary stream");
    }
    const totalBytes = result.chunks.reduce((sum, c) => sum + c.length, 0);
    if (totalBytes !== originalBytes!.length) {
      throw new Error(
        `expected ${originalBytes!.length} bytes, got ${totalBytes}`,
      );
    }

    if (process.env.VERIFY) {
      let offset = 0;
      for (const chunk of result.chunks) {
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] !== originalBytes![offset + i]) {
            throw new Error(`byte mismatch at ${offset + i}`);
          }
        }
        offset += chunk.length;
      }
      // Reading twice must yield identical content (cached or not).
      const again = streamB.getBinaryChunks(false)!;
      if (
        again.chunks.length !== result.chunks.length ||
        again.chunks.some((c, i) => c.length !== result.chunks[i]!.length)
      ) {
        throw new Error("second getBinaryChunks read diverges");
      }
      // And the imported view must equal a from-scratch rebuild.
      streamB.rebuildFromCore();
      const rebuilt = streamB.getBinaryChunks(false)!;
      let rOffset = 0;
      for (const chunk of rebuilt.chunks) {
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] !== originalBytes![rOffset + i]) {
            throw new Error(`rebuild byte mismatch at ${rOffset + i}`);
          }
        }
        rOffset += chunk.length;
      }
    }
  } else {
    const streamB = contentB as RawCoStream<string>;
    const items = streamB.getSingleStream();
    tRead1 = performance.now();

    if (!items || items.length !== ITEMS) {
      throw new Error(`expected ${ITEMS} items, got ${items?.length}`);
    }

    if (process.env.VERIFY) {
      const before = JSON.stringify(streamB.toJSON());
      streamB.rebuildFromCore();
      const after = JSON.stringify(streamB.toJSON());
      if (before !== after) {
        throw new Error("imported view diverges from full rebuild");
      }
      for (let i = 0; i < items.length; i++) {
        if (items[i] !== `item-with-some-payload-${i}`) {
          throw new Error(`order mismatch at ${i}: ${items[i]}`);
        }
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
