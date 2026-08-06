import { getContentMessageSize } from "../coValueContentMessage.js";
import { CLIENT_USAGE_CONFIG } from "../config.js";
import { logger } from "../logger.js";
import type { SyncMessage } from "../sync.js";

export class ClientUsageTracker {
  private messageCount = 0;
  private contentBytes = 0;
  private windowStart = Date.now();
  private nextMessageRateWarningAt =
    CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW;
  private nextContentSizeWarningAt =
    CLIENT_USAGE_CONFIG.MAX_CONTENT_BYTES_PER_WINDOW;

  constructor(private peerId: string) {}

  track(msg: SyncMessage) {
    const now = Date.now();

    if (now - this.windowStart > CLIENT_USAGE_CONFIG.WINDOW_SIZE) {
      this.messageCount = 0;
      this.contentBytes = 0;
      this.windowStart = now;
      this.nextMessageRateWarningAt =
        CLIENT_USAGE_CONFIG.MAX_MESSAGES_PER_WINDOW;
      this.nextContentSizeWarningAt =
        CLIENT_USAGE_CONFIG.MAX_CONTENT_BYTES_PER_WINDOW;
    }

    this.messageCount++;

    if (msg.action === "content") {
      this.contentBytes += getContentMessageSize(msg);
    }

    if (this.messageCount > this.nextMessageRateWarningAt) {
      logger.warn("Client peer exceeding message rate threshold", {
        peerId: this.peerId,
        warningType: "message_rate",
        messageCount: this.messageCount,
        threshold: this.nextMessageRateWarningAt,
      });
      this.nextMessageRateWarningAt *= 2;
    }

    if (this.contentBytes > this.nextContentSizeWarningAt) {
      logger.warn("Client peer exceeding content size threshold", {
        peerId: this.peerId,
        warningType: "content_size",
        contentBytes: this.contentBytes,
        threshold: this.nextContentSizeWarningAt,
      });
      this.nextContentSizeWarningAt *= 2;
    }
  }
}
