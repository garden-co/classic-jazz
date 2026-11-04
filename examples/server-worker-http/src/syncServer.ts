import { apiKey } from "./apiKey";

const url =
  process.env.NEXT_PUBLIC_JAZZ_SYNC_SERVER ??
  `wss://cloud.jazz.tools/?key=${apiKey}`;

if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
  throw new Error("NEXT_PUBLIC_JAZZ_SYNC_SERVER must be a WebSocket URL");
}

export const syncServer = url as `ws://${string}` | `wss://${string}`;
