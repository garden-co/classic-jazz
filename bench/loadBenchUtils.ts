/**
 * Shared scaffolding for the CoValue load benchmarks: node factory, optional
 * CPU profiling (PROFILE=<file>), and the warmup + measure + report loop.
 */
import { ControlledAgent, LocalNode } from "cojson";
import type { WasmCrypto } from "cojson/crypto/WasmCrypto";

export function ms(n: number) {
  return `${n.toFixed(1)}ms`;
}

export function createNode(
  crypto: WasmCrypto,
  agentSecret = crypto.newRandomAgentSecret(),
) {
  const agent = new ControlledAgent(agentSecret, crypto);
  const node = new LocalNode(
    agentSecret,
    crypto.newRandomSessionID(agent.id),
    crypto,
  );
  return { node, agentSecret };
}

async function startProfilerIfRequested(): Promise<
  (() => Promise<void>) | undefined
> {
  if (!process.env.PROFILE) {
    return undefined;
  }
  const inspector = await import("node:inspector");
  const fs = await import("node:fs");
  const session = new inspector.Session();
  session.connect();
  const post = (method: string, params?: object) =>
    new Promise<any>((resolve, reject) =>
      session.post(method, params, (err, res) =>
        err ? reject(err) : resolve(res),
      ),
    );
  await post("Profiler.enable");
  await post("Profiler.start");
  return async () => {
    const { profile } = await post("Profiler.stop");
    fs.writeFileSync(process.env.PROFILE!, JSON.stringify(profile));
    console.log(`profile written to ${process.env.PROFILE}`);
  };
}

/**
 * Warm up once, optionally profile, run `runs` measured iterations and print
 * the best and median import/read/total times.
 */
export async function measureLoad(
  loadOnFreshNode: () => Promise<{
    import: number;
    read: number;
    total: number;
  }>,
  runs = 5,
) {
  await loadOnFreshNode(); // warmup

  const stopProfiler = await startProfilerIfRequested();

  const results: { import: number; read: number; total: number }[] = [];
  for (let i = 0; i < runs; i++) {
    results.push(await loadOnFreshNode());
  }

  await stopProfiler?.();

  const best = results.reduce((a, b) => (a.total < b.total ? a : b));
  const median = [...results].sort((a, b) => a.total - b.total)[
    Math.floor(results.length / 2)
  ]!;

  console.log(
    `load (import+read) best:   import=${ms(best.import)} read=${ms(best.read)} total=${ms(best.total)}`,
  );
  console.log(
    `load (import+read) median: import=${ms(median.import)} read=${ms(median.read)} total=${ms(median.total)}`,
  );
}
