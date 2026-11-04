import * as fs from "fs";
import { createWorkerAccount } from "jazz-run/createWorkerAccount";
import { syncServer } from "./src/syncServer";

if (
  fs.existsSync(".env") ||
  (process.env.JAZZ_WORKER_ACCOUNT &&
    process.env.JAZZ_WORKER_SECRET &&
    process.env.NEXT_PUBLIC_JAZZ_WORKER_ACCOUNT)
) {
  process.exit(0);
}

async function main() {
  const account = await createWorkerAccount({
    name: "jazz-paper-scissors-worker",
    peer: syncServer,
  });

  fs.writeFileSync(
    ".env",
    `
JAZZ_WORKER_ACCOUNT=${account.accountID}
NEXT_PUBLIC_JAZZ_WORKER_ACCOUNT=${account.accountID}
JAZZ_WORKER_SECRET=${account.agentSecret}
`,
  );

  process.exit(0);
}

main();
