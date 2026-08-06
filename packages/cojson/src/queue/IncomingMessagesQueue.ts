import { Counter, Histogram, ValueType, metrics } from "@opentelemetry/api";
import type { PeerState } from "../PeerState.js";
import type { SyncMessage } from "../sync.js";
import { ClientUsageTracker } from "./ClientUsageTracker.js";
import { LinkedList } from "./LinkedList.js";

/**
 * A queue that manages incoming sync messages across different peers using a round-robin approach.
 *
 * This class manages incoming sync messages from multiple peers, ensuring fair processing
 * by cycling through each peer's message queue in a round-robin fashion.
 *
 * Queue processing and scheduling is handled by SyncManager.processQueues().
 */
export class IncomingMessagesQueue {
  private pullCounter: Counter;
  private pushCounter: Counter;
  private pushByTypeCounter: Counter;
  private processingTimeHistogram: Histogram;

  queues: [LinkedList<SyncMessage>, PeerState][];
  peerToQueue: WeakMap<PeerState, LinkedList<SyncMessage>>;
  currentQueue = 0;
  private clientUsageTrackers: WeakMap<PeerState, ClientUsageTracker>;

  constructor(private processQueues: () => void) {
    this.pullCounter = metrics
      .getMeter("cojson")
      .createCounter(`jazz.messagequeue.incoming.pulled`, {
        description: "Number of messages pulled from the queue",
        valueType: ValueType.INT,
        unit: "1",
      });
    this.pushCounter = metrics
      .getMeter("cojson")
      .createCounter(`jazz.messagequeue.incoming.pushed`, {
        description: "Number of messages pushed to the queue",
        valueType: ValueType.INT,
        unit: "1",
      });
    this.pushByTypeCounter = metrics
      .getMeter("cojson")
      .createCounter(`jazz.messagequeue.incoming.pushed.by_type`, {
        description: "Number of messages pushed to the queue by message type",
        valueType: ValueType.INT,
        unit: "1",
      });
    this.processingTimeHistogram = metrics
      .getMeter("cojson")
      .createHistogram(`jazz.messagequeue.incoming.processing_time`, {
        description: "Time spent processing incoming sync messages by type",
        valueType: ValueType.DOUBLE,
        unit: "ms",
      });

    /**
     * This makes sure that those metrics are generated (and emitted) as soon as the queue is created.
     * This is to avoid edge cases where one series reset is delayed, which would cause spikes or dips
     * when queried - and it also more correctly represents the actual state of the queue after a restart.
     */
    this.pullCounter.add(0, {
      peerRole: "client",
    });
    this.pushCounter.add(0, {
      peerRole: "client",
    });
    this.pullCounter.add(0, {
      peerRole: "server",
    });
    this.pushCounter.add(0, {
      peerRole: "server",
    });

    this.queues = [];
    this.peerToQueue = new WeakMap();
    this.clientUsageTrackers = new WeakMap();
  }

  private getClientUsageTracker(peer: PeerState): ClientUsageTracker {
    let tracker = this.clientUsageTrackers.get(peer);
    if (!tracker) {
      tracker = new ClientUsageTracker(peer.id);
      this.clientUsageTrackers.set(peer, tracker);
    }
    return tracker;
  }

  public push(msg: SyncMessage, peer: PeerState) {
    if (peer.role === "client") {
      this.getClientUsageTracker(peer).track(msg);
    }

    const queue = this.peerToQueue.get(peer);

    if (!queue) {
      const newQueue = new LinkedList<SyncMessage>();
      this.peerToQueue.set(peer, newQueue);
      this.queues.push([newQueue, peer]);
      newQueue.push(msg);
    } else {
      queue.push(msg);
    }

    this.pushCounter.add(1, {
      peerRole: peer.role,
    });
    this.pushByTypeCounter.add(1, {
      peerRole: peer.role,
      messageType: msg.action,
    });

    this.processQueues();
  }

  public pull() {
    const entry = this.queues[this.currentQueue];

    if (!entry) {
      return undefined;
    }

    const [queue, peer] = entry;
    const msg = queue.shift();

    if (queue.isEmpty()) {
      this.queues.splice(this.currentQueue, 1);
      this.peerToQueue.delete(peer);
    } else {
      this.currentQueue++;
    }

    if (this.currentQueue >= this.queues.length) {
      this.currentQueue = 0;
    }

    if (msg) {
      this.pullCounter.add(1, {
        peerRole: peer.role,
      });

      return { msg, peer };
    }

    return undefined;
  }

  public recordProcessingTime(
    messageType: SyncMessage["action"],
    durationMs: number,
  ) {
    this.processingTimeHistogram.record(durationMs, {
      messageType,
    });
  }
}
