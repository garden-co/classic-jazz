import { afterEach, describe, expect, test, vi } from "vitest";
import { CLIENT_USAGE_CONFIG } from "../config.js";
import { logger } from "../logger.js";
import { PeerState } from "../PeerState.js";
import { IncomingMessagesQueue } from "../queue/IncomingMessagesQueue.js";
import { ConnectedPeerChannel } from "../streamUtils.js";
import { Peer, SyncMessage } from "../sync.js";
import {
  createTestMetricReader,
  tearDownTestMetricReader,
} from "./testUtils.js";

function createMockPeer(id: string): Peer {
  return {
    id,
    role: "client",
    incoming: new ConnectedPeerChannel(),
    outgoing: new ConnectedPeerChannel(),
  };
}

function createMockPeerState(
  id: string,
  role: "client" | "server" = "client",
): PeerState {
  const peer = createMockPeer(id);
  peer.role = role;
  return new PeerState(peer, undefined);
}

function createMockSyncMessage(
  id: string,
  action: "load" | "known" | "content" | "done" = "load",
): SyncMessage {
  if (action === "load" || action === "known") {
    return {
      action,
      id: `co_z${id}`,
      header: false,
      sessions: {},
    };
  } else if (action === "content") {
    return {
      action: "content",
      id: `co_z${id}`,
      priority: 3, // MEDIUM priority
      new: {},
    };
  } else {
    return {
      action: "done",
      id: `co_z${id}`,
    };
  }
}

function createContentMessageWithSize(
  id: string,
  sizeInBytes: number,
): SyncMessage {
  return {
    action: "content",
    id: `co_z${id}` as any,
    priority: 3,
    new: {
      ["co_zTestSession_session_z123" as any]: {
        after: 0,
        newTransactions: [
          {
            privacy: "trusting" as const,
            changes: new Uint8Array(sizeInBytes),
            madeAt: 0,
          },
        ],
        lastSignature: "signature_z123" as any,
      },
    },
  };
}

function setup() {
  const processQueues = vi.fn();
  const metricReader = createTestMetricReader();
  const queue = new IncomingMessagesQueue(processQueues);
  const peer1 = createMockPeerState("peer1");
  const peer2 = createMockPeerState("peer2");

  return { queue, peer1, peer2, metricReader, processQueues };
}

afterEach(() => {
  tearDownTestMetricReader();
});

describe("IncomingMessagesQueue", () => {
  describe("constructor", () => {
    test("should initialize with empty state", () => {
      const { queue } = setup();
      expect(queue["queues"]).toEqual([]);
      expect(queue.currentQueue).toBe(0);
    });
  });

  describe("push", () => {
    test("should add message to new peer queue", () => {
      const { queue, peer1 } = setup();
      const msg = createMockSyncMessage("test");
      queue.push(msg, peer1);

      expect(queue["queues"].length).toBe(1);
      expect(queue["queues"][0]?.[1]).toBe(peer1);
      expect(queue["peerToQueue"].has(peer1)).toBe(true);
    });

    test("should add message to existing peer queue", () => {
      const { queue, peer1 } = setup();
      const msg1 = createMockSyncMessage("test1");
      const msg2 = createMockSyncMessage("test2");

      queue.push(msg1, peer1);
      queue.push(msg2, peer1);

      expect(queue["queues"].length).toBe(1);
      const peerQueue = queue["peerToQueue"].get(peer1);
      expect(peerQueue).toBeDefined();
      expect(peerQueue?.length).toBe(2);
    });

    test("should handle multiple peers", () => {
      const { queue, peer1, peer2 } = setup();
      const msg1 = createMockSyncMessage("test1");
      const msg2 = createMockSyncMessage("test2");

      queue.push(msg1, peer1);
      queue.push(msg2, peer2);

      expect(queue["queues"].length).toBe(2);
      expect(queue["peerToQueue"].has(peer1)).toBe(true);
      expect(queue["peerToQueue"].has(peer2)).toBe(true);
    });
  });

  describe("pull", () => {
    test("should return undefined for empty queue", () => {
      const { queue } = setup();
      expect(queue.pull()).toBeUndefined();
    });

    test("should pull message from first peer", () => {
      const { queue, peer1 } = setup();
      const msg = createMockSyncMessage("test");
      queue.push(msg, peer1);

      const result = queue.pull();
      expect(result).toEqual({ msg, peer: peer1 });
    });

    test("should pull messages in round-robin order", () => {
      const { queue, peer1, peer2 } = setup();
      const msg1 = createMockSyncMessage("test1");
      const msg2 = createMockSyncMessage("test2");
      const msg3 = createMockSyncMessage("test3");

      queue.push(msg1, peer1);
      queue.push(msg2, peer1);
      queue.push(msg3, peer2);

      // First pull from peer1
      expect(queue.pull()).toEqual({ msg: msg1, peer: peer1 });
      // Second pull from peer2 (round-robin)
      expect(queue.pull()).toEqual({ msg: msg3, peer: peer2 });
      // Third pull from peer1 (back to first)
      expect(queue.pull()).toEqual({ msg: msg2, peer: peer1 });
    });

    test("should remove peer when their queue becomes empty", () => {
      const { queue, peer1 } = setup();
      const msg = createMockSyncMessage("test");
      queue.push(msg, peer1);

      queue.pull();

      expect(queue["queues"].length).toBe(0);
      expect(queue["peerToQueue"].has(peer1)).toBe(false);
    });

    test("should not advance currentQueue when only one peer has messages", () => {
      const { queue, peer1 } = setup();
      const msg1 = createMockSyncMessage("test1");
      const msg2 = createMockSyncMessage("test2");

      queue.push(msg1, peer1);
      queue.push(msg2, peer1);

      queue.pull(); // Pull first message

      expect(queue.currentQueue).toBe(0); // Only one queue, so stays at 0
      expect(queue["queues"].length).toBe(1); // Peer still has messages
    });

    test("should reset currentQueue when it reaches queue length", () => {
      const { queue, peer1, peer2 } = setup();
      const msg1 = createMockSyncMessage("test1");
      const msg2 = createMockSyncMessage("test2");

      queue.push(msg1, peer1);
      queue.push(msg2, peer2);

      queue.pull(); // Pull from peer1, currentQueue becomes 1
      queue.pull(); // Pull from peer2, currentQueue becomes 2, then resets to 0

      expect(queue.currentQueue).toBe(0);
    });

    test("should handle currentQueue reset when queues are removed", () => {
      const { queue, peer1, peer2 } = setup();
      const msg1 = createMockSyncMessage("test1");
      const msg2 = createMockSyncMessage("test2");

      queue.push(msg1, peer1);
      queue.push(msg2, peer2);

      queue.pull(); // Pull from peer1, currentQueue becomes 1
      queue.pull(); // Pull from peer2, currentQueue becomes 2, then resets to 0

      // Add another message to peer1
      const msg3 = createMockSyncMessage("test3");
      queue.push(msg3, peer1);

      // Should pull from peer1 again (currentQueue is 0)
      expect(queue.pull()).toEqual({ msg: msg3, peer: peer1 });
    });
  });

  describe("edge cases", () => {
    test("should handle peer with multiple messages correctly", () => {
      const { queue, peer1 } = setup();
      const msg1 = createMockSyncMessage("test1");
      const msg2 = createMockSyncMessage("test2");
      const msg3 = createMockSyncMessage("test3");

      queue.push(msg1, peer1);
      queue.push(msg2, peer1);
      queue.push(msg3, peer1);

      expect(queue.pull()).toEqual({ msg: msg1, peer: peer1 });
      expect(queue["queues"].length).toBe(1); // Peer still has messages
      expect(queue.currentQueue).toBe(0); // Only one queue, so stays at 0

      expect(queue.pull()).toEqual({ msg: msg2, peer: peer1 });
      expect(queue["queues"].length).toBe(1); // Peer still has messages
      expect(queue.currentQueue).toBe(0); // Only one queue, so stays at 0

      expect(queue.pull()).toEqual({ msg: msg3, peer: peer1 });
      expect(queue["queues"].length).toBe(0); // Peer queue is now empty
      expect(queue.currentQueue).toBe(0); // Reset to 0
    });

    test("should handle rapid push and pull operations", () => {
      const { queue, peer1 } = setup();
      const msg1 = createMockSyncMessage("test1");
      const msg2 = createMockSyncMessage("test2");

      queue.push(msg1, peer1);
      expect(queue.pull()).toEqual({ msg: msg1, peer: peer1 });

      queue.push(msg2, peer1);
      expect(queue.pull()).toEqual({ msg: msg2, peer: peer1 });

      expect(queue["queues"].length).toBe(0);
      expect(queue["peerToQueue"].has(peer1)).toBe(false);
    });

    test("should handle different message types", () => {
      const { queue, peer1, peer2 } = setup();
      const loadMsg = createMockSyncMessage("load", "load");
      const knownMsg = createMockSyncMessage("known", "known");
      const contentMsg = createMockSyncMessage("content", "content");
      const doneMsg = createMockSyncMessage("done", "done");

      queue.push(loadMsg, peer1);
      queue.push(knownMsg, peer1);
      queue.push(contentMsg, peer2);
      queue.push(doneMsg, peer2);

      expect(queue.pull()).toEqual({ msg: loadMsg, peer: peer1 });
      expect(queue.pull()).toEqual({ msg: contentMsg, peer: peer2 });
      expect(queue.pull()).toEqual({ msg: knownMsg, peer: peer1 });
      expect(queue.pull()).toEqual({ msg: doneMsg, peer: peer2 });
    });
  });

  describe("metrics", () => {
    test("should increment push counter when pushing messages", async () => {
      const { queue, peer1, metricReader } = setup();
      const msg = createMockSyncMessage("test");

      queue.push(msg, peer1);

      const pushValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pushed",
        { peerRole: "client" },
      );

      expect(pushValue).toBe(1);
    });

    test("should track pushed message count by incoming message type", async () => {
      const { queue, peer1, metricReader } = setup();

      queue.push(createMockSyncMessage("load-1", "load"), peer1);
      queue.push(createMockSyncMessage("known-1", "known"), peer1);
      queue.push(createMockSyncMessage("known-2", "known"), peer1);
      queue.push(createMockSyncMessage("content-1", "content"), peer1);
      queue.push(createMockSyncMessage("done-1", "done"), peer1);

      const loadValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pushed.by_type",
        { peerRole: "client", messageType: "load" },
      );
      const knownValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pushed.by_type",
        { peerRole: "client", messageType: "known" },
      );
      const contentValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pushed.by_type",
        { peerRole: "client", messageType: "content" },
      );
      const doneValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pushed.by_type",
        { peerRole: "client", messageType: "done" },
      );

      expect(loadValue).toBe(1);
      expect(knownValue).toBe(2);
      expect(contentValue).toBe(1);
      expect(doneValue).toBe(1);
    });

    test("should increment pull counter when pulling messages", async () => {
      const { queue, peer1, metricReader } = setup();
      const msg = createMockSyncMessage("test");

      queue.push(msg, peer1);
      queue.pull();

      const pullValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pulled",
        { peerRole: "client" },
      );

      expect(pullValue).toBe(1);
    });

    test("should track metrics for both client and server peers", async () => {
      const { queue, peer1, metricReader } = setup();

      // Create a server peer
      const serverPeer = createMockPeerState("server-peer", "server");

      const clientMsg = createMockSyncMessage("client-test");
      const serverMsg = createMockSyncMessage("server-test");

      queue.push(clientMsg, peer1); // client peer
      queue.push(serverMsg, serverPeer); // server peer

      const clientPushValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pushed",
        { peerRole: "client" },
      );

      const serverPushValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pushed",
        { peerRole: "server" },
      );

      expect(clientPushValue).toBe(1);
      expect(serverPushValue).toBe(1);
    });

    test("should track pull metrics for both client and server peers", async () => {
      const { queue, peer1, metricReader } = setup();

      // Create a server peer
      const serverPeer = createMockPeerState("server-peer", "server");

      const clientMsg = createMockSyncMessage("client-test");
      const serverMsg = createMockSyncMessage("server-test");

      queue.push(clientMsg, peer1);
      queue.push(serverMsg, serverPeer);

      queue.pull(); // Pull client message
      queue.pull(); // Pull server message

      const clientPullValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pulled",
        { peerRole: "client" },
      );

      const serverPullValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pulled",
        { peerRole: "server" },
      );

      expect(clientPullValue).toBe(1);
      expect(serverPullValue).toBe(1);
    });

    test("should not increment pull counter when queue is empty", async () => {
      const { queue, metricReader } = setup();

      queue.pull(); // Should return undefined

      const pullValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pulled",
        { peerRole: "client" },
      );

      expect(pullValue).toBe(0);
    });

    test("should track multiple pushes and pulls correctly", async () => {
      const { queue, peer1, metricReader } = setup();
      const msg1 = createMockSyncMessage("test1");
      const msg2 = createMockSyncMessage("test2");
      const msg3 = createMockSyncMessage("test3");

      queue.push(msg1, peer1);
      queue.push(msg2, peer1);
      queue.push(msg3, peer1);

      queue.pull(); // Pull first message
      queue.pull(); // Pull second message

      const pushValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pushed",
        { peerRole: "client" },
      );

      const pullValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pulled",
        { peerRole: "client" },
      );

      expect(pushValue).toBe(3);
      expect(pullValue).toBe(2);
    });

    test("should initialize metrics with zero values for both peer roles", async () => {
      const { metricReader } = setup();

      // The constructor should initialize metrics with 0 values
      const clientPushValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pushed",
        { peerRole: "client" },
      );

      const serverPushValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pushed",
        { peerRole: "server" },
      );

      const clientPullValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pulled",
        { peerRole: "client" },
      );

      const serverPullValue = await metricReader.getMetricValue(
        "jazz.messagequeue.incoming.pulled",
        { peerRole: "server" },
      );

      expect(clientPushValue).toBe(0);
      expect(serverPushValue).toBe(0);
      expect(clientPullValue).toBe(0);
      expect(serverPullValue).toBe(0);
    });
  });

  describe("client usage tracking", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    const savedConfig = { ...CLIENT_USAGE_CONFIG };

    afterEach(() => {
      vi.useRealTimers();
      warnSpy?.mockRestore();
      Object.assign(CLIENT_USAGE_CONFIG, savedConfig);
    });

    test("should not warn below message rate threshold", () => {
      warnSpy = vi.spyOn(logger, "warn");
      const { queue, peer1 } = setup();

      for (
        let i = 0;
        i < CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW - 1;
        i++
      ) {
        queue.push(createMockSyncMessage(`msg-${i}`), peer1);
      }

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("message rate"),
        expect.anything(),
      );
    });

    test("should warn when message count exceeds threshold", () => {
      warnSpy = vi.spyOn(logger, "warn");
      const { queue, peer1 } = setup();

      for (
        let i = 0;
        i < CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW + 1;
        i++
      ) {
        queue.push(createMockSyncMessage(`msg-${i}`), peer1);
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("message rate"),
        expect.objectContaining({
          peerId: "peer1",
          warningType: "message_rate",
        }),
      );
    });

    test("should warn when content bytes exceed threshold", () => {
      warnSpy = vi.spyOn(logger, "warn");
      const { queue, peer1 } = setup();

      const largeMsg = createContentMessageWithSize(
        "large",
        CLIENT_USAGE_CONFIG.MAX_CONTENT_BYTES_PER_WINDOW + 1,
      );
      queue.push(largeMsg, peer1);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("content size"),
        expect.objectContaining({
          peerId: "peer1",
          warningType: "content_size",
        }),
      );
    });

    test("should accumulate content bytes across multiple messages in same window", () => {
      warnSpy = vi.spyOn(logger, "warn");
      const { queue, peer1 } = setup();

      const halfThreshold = Math.ceil(
        CLIENT_USAGE_CONFIG.MAX_CONTENT_BYTES_PER_WINDOW / 2,
      );

      queue.push(createContentMessageWithSize("part1", halfThreshold), peer1);

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("content size"),
        expect.anything(),
      );

      queue.push(
        createContentMessageWithSize("part2", halfThreshold + 1),
        peer1,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("content size"),
        expect.objectContaining({
          peerId: "peer1",
          warningType: "content_size",
        }),
      );
    });

    test("should warn at exponentially increasing thresholds", () => {
      warnSpy = vi.spyOn(logger, "warn");
      CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW = 10;

      const { queue, peer1 } = setup();

      // First warning at 10
      for (let i = 0; i < 11; i++) {
        queue.push(createMockSyncMessage(`msg-${i}`), peer1);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // No warning between 10 and 20
      for (let i = 11; i < 20; i++) {
        queue.push(createMockSyncMessage(`msg-${i}`), peer1);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Second warning at 20
      queue.push(createMockSyncMessage("msg-20"), peer1);
      expect(warnSpy).toHaveBeenCalledTimes(2);

      // Third warning at 40
      for (let i = 21; i < 41; i++) {
        queue.push(createMockSyncMessage(`msg-${i}`), peer1);
      }
      expect(warnSpy).toHaveBeenCalledTimes(3);
    });

    test("should warn again in a new window", () => {
      vi.useFakeTimers();
      warnSpy = vi.spyOn(logger, "warn");
      CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW = 10;

      const { queue, peer1 } = setup();

      // Exceed threshold in first window
      for (let i = 0; i < 11; i++) {
        queue.push(createMockSyncMessage(`msg-${i}`), peer1);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Advance past window
      vi.advanceTimersByTime(CLIENT_USAGE_CONFIG.WINDOW_SIZE + 1);

      // Exceed threshold again in new window — should warn again
      for (let i = 0; i < 11; i++) {
        queue.push(createMockSyncMessage(`msg2-${i}`), peer1);
      }
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    test("should reset counters when window expires", () => {
      vi.useFakeTimers();
      warnSpy = vi.spyOn(logger, "warn");
      const { queue, peer1 } = setup();

      for (
        let i = 0;
        i < CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW - 1;
        i++
      ) {
        queue.push(createMockSyncMessage(`msg-${i}`), peer1);
      }

      // Advance past window
      vi.advanceTimersByTime(CLIENT_USAGE_CONFIG.WINDOW_SIZE + 1);

      // Push under threshold again — should not warn (window reset)
      for (
        let i = 0;
        i < CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW - 1;
        i++
      ) {
        queue.push(createMockSyncMessage(`msg2-${i}`), peer1);
      }

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("message rate"),
        expect.anything(),
      );
    });

    test("should not track server peers", () => {
      warnSpy = vi.spyOn(logger, "warn");
      const { queue } = setup();
      const serverPeer = createMockPeerState("server-peer", "server");

      for (
        let i = 0;
        i < CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW + 100;
        i++
      ) {
        queue.push(createMockSyncMessage(`msg-${i}`), serverPeer);
      }

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("message rate"),
        expect.anything(),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("content size"),
        expect.anything(),
      );
    });

    test("message rate and content size warnings fire independently", () => {
      warnSpy = vi.spyOn(logger, "warn");
      const { queue, peer1 } = setup();

      const largeMsg = createContentMessageWithSize(
        "large",
        CLIENT_USAGE_CONFIG.MAX_CONTENT_BYTES_PER_WINDOW + 1,
      );
      queue.push(largeMsg, peer1);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("content size"),
        expect.objectContaining({ warningType: "content_size" }),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("message rate"),
        expect.anything(),
      );
    });

    test("new PeerState instance gets fresh stats even with same peer ID", () => {
      warnSpy = vi.spyOn(logger, "warn");
      const { queue } = setup();

      // First peer instance — push just under threshold
      const peer1a = createMockPeerState("peer1");
      for (
        let i = 0;
        i < CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW - 1;
        i++
      ) {
        queue.push(createMockSyncMessage(`msg-${i}`), peer1a);
      }

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("message rate"),
        expect.anything(),
      );

      // Second peer instance with same ID (simulates reconnect) — push under threshold again
      // If stats leaked from the old instance, this would cross the threshold
      const peer1b = createMockPeerState("peer1");
      for (
        let i = 0;
        i < CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW - 1;
        i++
      ) {
        queue.push(createMockSyncMessage(`msg2-${i}`), peer1b);
      }

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("message rate"),
        expect.anything(),
      );
    });
  });
});
