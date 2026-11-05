/**
    In order to not block other concurrently syncing CoValues we introduce a maximum size of transactions,
    since they are the smallest unit of progress that can be synced within a CoValue.
    This is particularly important for storing binary data in CoValues, since they are likely to be at least on the order of megabytes.
    This also means that we want to keep signatures roughly after each MAX_RECOMMENDED_TX size chunk,
    to be able to verify partially loaded CoValues or CoValues that are still being created (like a video live stream).
**/
export const TRANSACTION_CONFIG = {
  MAX_RECOMMENDED_TX_SIZE: 100 * 1024,
};

export function setMaxRecommendedTxSize(size: number) {
  TRANSACTION_CONFIG.MAX_RECOMMENDED_TX_SIZE = size;
}

export const CO_VALUE_LOADING_CONFIG = {
  MAX_RETRIES: 1,
  TIMEOUT: 60_000,
  RETRY_DELAY: 3000,
  MAX_IN_FLIGHT_LOADS_PER_PEER: 1000,
};

export function setCoValueLoadingMaxRetries(maxRetries: number) {
  CO_VALUE_LOADING_CONFIG.MAX_RETRIES = maxRetries;
}

export function setCoValueLoadingTimeout(timeout: number) {
  CO_VALUE_LOADING_CONFIG.TIMEOUT = timeout;
}

export function setCoValueLoadingRetryDelay(delay: number) {
  CO_VALUE_LOADING_CONFIG.RETRY_DELAY = delay;
}

export const SYNC_SCHEDULER_CONFIG = {
  INCOMING_MESSAGES_TIME_BUDGET: 50,
};

export function setIncomingMessagesTimeBudget(budget: number) {
  SYNC_SCHEDULER_CONFIG.INCOMING_MESSAGES_TIME_BUDGET = budget;
}

export const GARBAGE_COLLECTOR_CONFIG = {
  MAX_AGE: 1000 * 60 * 10, // 10 minutes
  INTERVAL: 1000 * 60 * 5, // 5 minutes
};

export function setGarbageCollectorMaxAge(maxAge: number) {
  GARBAGE_COLLECTOR_CONFIG.MAX_AGE = maxAge;
}

export function setGarbageCollectorInterval(interval: number) {
  GARBAGE_COLLECTOR_CONFIG.INTERVAL = interval;
}

export const WEBSOCKET_CONFIG = {
  MAX_OUTGOING_MESSAGES_CHUNK_BYTES: 25_000,
};

export function setMaxOutgoingMessagesChunkBytes(bytes: number) {
  WEBSOCKET_CONFIG.MAX_OUTGOING_MESSAGES_CHUNK_BYTES = bytes;
}

export function setMaxInFlightLoadsPerPeer(limit: number) {
  CO_VALUE_LOADING_CONFIG.MAX_IN_FLIGHT_LOADS_PER_PEER = limit;
}

export const STORAGE_RECONCILIATION_CONFIG = {
  BATCH_SIZE: 100,
  LOCK_TTL_MS: 24 * 60 * 60 * 1000, // 1 day
  RECONCILIATION_INTERVAL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
};

export function setStorageReconciliationBatchSize(size: number) {
  STORAGE_RECONCILIATION_CONFIG.BATCH_SIZE = size;
}

export function setStorageReconciliationLockTTL(ttl: number) {
  STORAGE_RECONCILIATION_CONFIG.LOCK_TTL_MS = ttl;
}

export function setStorageReconciliationInterval(interval: number) {
  STORAGE_RECONCILIATION_CONFIG.RECONCILIATION_INTERVAL_MS = interval;
}

export const CLIENT_USAGE_CONFIG = {
  WINDOW_SIZE: 60_000, // 60 seconds
  MAX_MESSAGES_PER_WINDOW: 5_000, // 5000 messages
  MAX_CONTENT_BYTES_PER_WINDOW: 200 * 1024 * 1024, // 200 MB
};
