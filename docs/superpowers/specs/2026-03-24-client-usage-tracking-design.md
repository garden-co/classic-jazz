# Client Usage Tracking via Warning Logs

## Problem

Some clients push too much content or too many messages through the sync queues. This could be intentional heavy usage, or unintentional (e.g., a useEffect loop or misconfigured sync). We need visibility into which clients are exceeding expected usage patterns so we can investigate and help.

OTel metrics are not suitable here because `peerId` is an unbound dimension — tracking per-peer metrics would cause cardinality explosion.

## Solution

Add per-client-peer usage tracking in `IncomingMessagesQueue` that emits `logger.warn()` when a client exceeds message rate or content size thresholds within a time window.

## Design

### Tracking state

A `WeakMap<PeerState, ClientPeerStats>` in `IncomingMessagesQueue`, where:

```ts
interface ClientPeerStats {
  messageCount: number;
  contentBytes: number;
  windowStart: number;                // performance.now() timestamp
  lastWarnedAtMessageRate: number;    // last time a message rate warning was emitted
  lastWarnedAtContentSize: number;    // last time a content size warning was emitted
}
```

Only peers with `role === "client"` are tracked.

Note: Because `IncomingMessagesQueue` may still hold references to `PeerState` in its `queues` array (for unprocessed messages), WeakMap entries may persist briefly after a peer disconnects until its queued messages are drained. This is acceptable — the stats will be GC'd once the peer's messages are fully processed and the `PeerState` reference is released.

### Where it hooks in

`IncomingMessagesQueue.push(msg, peer)` — the single entry point for all incoming messages. On each push for a client peer:

1. Look up or create `ClientPeerStats` for the peer
2. If `now - windowStart > WINDOW_SIZE`, reset counters (tumbling window)
3. Increment `messageCount`
4. If `msg.action === "content"`, compute content size via `getContentMessageSize(msg)` (from `coValueContentMessage.ts`) and add to `contentBytes`
5. Check each threshold independently — each has its own cooldown timer (`lastWarnedAtMessageRate` / `lastWarnedAtContentSize`), so both warning types can fire in the same window

The tumbling window is purely push-driven: counters reset on the next push after the window expires. A peer that goes idle and returns will start a fresh window on its next message. No timers or background tasks.

### Thresholds (configurable defaults)

```ts
const CLIENT_USAGE_CONFIG = {
  WINDOW_SIZE: 60_000,            // 60 second tumbling window
  MAX_MESSAGES_PER_WINDOW: 1000,  // messages per window
  MAX_CONTENT_BYTES_PER_WINDOW: 10 * 1024 * 1024,  // 10 MB per window
  WARN_COOLDOWN: 60_000,          // max one warning per threshold type per peer per 60s
};
```

These follow the existing config pattern used by `CO_VALUE_LOADING_CONFIG` and `SYNC_SCHEDULER_CONFIG`. Thresholds are starting estimates — they can be tuned once we observe real traffic patterns.

### Warning log format

```ts
logger.warn("Client peer exceeding message rate threshold", {
  peerId: peer.id,
  warningType: "message_rate",
  messageCount: stats.messageCount,
  threshold: CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW,
  windowSeconds: CLIENT_USAGE_CONFIG.WINDOW_SIZE / 1000,
})

logger.warn("Client peer exceeding content size threshold", {
  peerId: peer.id,
  warningType: "content_size",
  contentBytes: stats.contentBytes,
  threshold: CLIENT_USAGE_CONFIG.MAX_CONTENT_BYTES_PER_WINDOW,
  windowSeconds: CLIENT_USAGE_CONFIG.WINDOW_SIZE / 1000,
})
```

The `warningType` field enables structured log filtering.

## Files to modify

- `packages/cojson/src/queue/IncomingMessagesQueue.ts` — add tracking logic in `push()`
- `packages/cojson/src/config.ts` — add `CLIENT_USAGE_CONFIG`

## Files to add

None.

## Testing

- Unit tests in `packages/cojson/src/tests/IncomingMessagesQueue.test.ts` (extend existing test file)
- Test cases:
  - No warning emitted below thresholds
  - Warning emitted when message count exceeds threshold
  - Warning emitted when content bytes exceed threshold
  - Warning cooldown prevents log spam (per threshold type independently)
  - Window reset clears counters
  - Only client peers are tracked (server peers ignored)
  - Multiple content messages accumulate bytes within one window
