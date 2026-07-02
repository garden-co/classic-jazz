import type { SessionNewContent } from "../sync.js";
import type { SignatureMismatchErrorMessage } from "../sync.js";
import type { LocalNode } from "../localNode.js";
import type { JsonObject, JsonValue } from "../jsonValue.js";
import { toConflictSessionID } from "../ids.js";
import type { ActiveSessionID } from "../ids.js";
import { logger } from "../logger.js";
import { isCurrentNodeSessionOwner, findCommonPrefixLength } from "./utils.js";
import { normalizeAuthoritativeSessionContent } from "./normalizeAuthoritativeSessionContent.js";

const activeRecoveries = new Set<string>();

export function recoverSignatureMismatch(
  local: LocalNode,
  msg: SignatureMismatchErrorMessage,
): void {
  if (!isCurrentNodeSessionOwner(local, msg.sessionID)) {
    logger.info("Skipping non-owner SignatureMismatch recovery", {
      id: msg.id,
      sessionID: msg.sessionID,
    });
    return;
  }

  if (!local.storage) {
    logger.warn("Skipping SignatureMismatch recovery: no storage", {
      id: msg.id,
      sessionID: msg.sessionID,
    });
    return;
  }

  const normalized = normalizeAuthoritativeSessionContent(msg.content);
  if (!normalized.ok) {
    logger.warn("Skipping SignatureMismatch recovery: invalid content", {
      id: msg.id,
      sessionID: msg.sessionID,
      error: normalized.error.message,
    });
    return;
  }

  const key = `${msg.id}::${msg.sessionID}`;
  if (activeRecoveries.has(key)) {
    return;
  }

  activeRecoveries.add(key);

  runRecovery(
    local,
    msg,
    normalized.value.content,
    normalized.value.transactions,
  )
    .catch((error) => {
      logger.error("SignatureMismatch recovery failed", {
        id: msg.id,
        sessionID: msg.sessionID,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      activeRecoveries.delete(key);
    });
}

async function runRecovery(
  local: LocalNode,
  msg: SignatureMismatchErrorMessage,
  authoritativeContent: SessionNewContent[],
  authoritativeTransactions: import("../coValueCore/verifiedState.js").Transaction[],
): Promise<void> {
  const coValue = local.getCoValue(msg.id);

  if (!coValue.isAvailable()) {
    logger.warn("Skipping recovery: CoValue not available", {
      id: msg.id,
    });
    return;
  }

  const core =
    coValue as import("../coValueCore/coValueCore.js").AvailableCoValueCore;
  const localSession = core.verified.getSession(msg.sessionID);

  if (!localSession) {
    logger.warn("Skipping recovery: local session not found", {
      id: msg.id,
      sessionID: msg.sessionID,
    });
    return;
  }

  // Step 1: Compute divergent transactions
  const commonPrefixLength = findCommonPrefixLength(
    localSession.transactions,
    authoritativeTransactions,
  );

  const divergentTransactions =
    localSession.transactions.slice(commonPrefixLength);

  // Step 2: Create conflict session with divergent transactions
  const conflictSessionID = toConflictSessionID(
    msg.sessionID as ActiveSessionID,
  );
  const existingConflictSession = core.verified.getSession(conflictSessionID);

  if (
    !existingConflictSession ||
    existingConflictSession.transactions.length === 0
  ) {
    for (const tx of divergentTransactions) {
      const parsed = core.getParsedTransaction(tx);
      if (!parsed) {
        logger.warn("Skipping divergent tx: no parsed changes in cache", {
          id: msg.id,
          sessionID: msg.sessionID,
        });
        continue;
      }

      core.makeTransaction(
        parsed.changes as JsonValue[],
        tx.privacy,
        parsed.meta as JsonObject | undefined,
        tx.madeAt,
        true, // isConflict
      );
    }
  }

  // Step 3: Wait for storage sync
  await local.syncManager.waitForStorageSync(msg.id);

  // Step 4: Replace session in storage
  await storeReplaceSessionHistory(
    local,
    msg.id,
    msg.sessionID,
    authoritativeContent,
  );

  // Step 5: Replace session in memory
  core.replaceSessionContent(msg.sessionID, authoritativeContent);

  logger.info("SignatureMismatch recovery completed", {
    id: msg.id,
    sessionID: msg.sessionID,
    divergentTransactions: divergentTransactions.length,
    commonPrefix: commonPrefixLength,
  });
}

function storeReplaceSessionHistory(
  local: LocalNode,
  coValueId: import("../ids.js").RawCoID,
  sessionID: import("../ids.js").SessionID,
  content: SessionNewContent[],
): Promise<void> {
  const result = local.storage!.store(
    {
      action: "replaceSessionHistory",
      coValueId,
      sessionID,
      content,
    },
    () => undefined,
  );

  // storageAsync returns a Promise, storageSync returns void
  return result ?? Promise.resolve();
}
