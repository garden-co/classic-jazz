import { startWorker } from "jazz-tools/worker";
import { syncServer } from "./syncServer";

export const jazzServerAccount = await startWorker({
  syncServer,
});
