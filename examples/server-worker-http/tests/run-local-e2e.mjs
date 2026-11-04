import { spawn } from "node:child_process";

function run(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

// Build the sync server and its dependencies before importing their output.
const dependenciesExitCode = await run([
  "turbo",
  "build",
  "--filter=jazz-run...",
]);
if (dependenciesExitCode !== 0) process.exit(dependenciesExitCode);

const { startSyncServer } = await import("jazz-run/startSyncServer");
const { createWorkerAccount } = await import("jazz-run/createWorkerAccount");
const server = await startSyncServer({
  host: "127.0.0.1",
  port: "0",
  inMemory: true,
  db: "",
});

let exitCode = 1;
try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local sync server did not bind a TCP port");
  }
  const peer = `ws://127.0.0.1:${address.port}`;
  const worker = await createWorkerAccount({
    name: "server-worker-http-e2e",
    peer,
  });
  const env = {
    ...process.env,
    CI: "true",
    NEXT_PUBLIC_JAZZ_SYNC_SERVER: peer,
    JAZZ_WORKER_ACCOUNT: worker.accountID,
    NEXT_PUBLIC_JAZZ_WORKER_ACCOUNT: worker.accountID,
    JAZZ_WORKER_SECRET: worker.agentSecret,
  };

  // Keep the same server alive through account provisioning, build, and tests.
  exitCode = await run(["turbo", "build"], env);
  if (exitCode === 0) {
    exitCode = await run(
      ["exec", "playwright", "test", ...process.argv.slice(2)],
      env,
    );
  }
} finally {
  server.close();
}

// Account provisioning owns a WebSocket too; exit closes that test-only client.
process.exit(exitCode);
