import type { Transaction } from "../coValueCore/verifiedState.js";
import type { SessionID } from "../ids.js";
import type { LocalNode } from "../localNode.js";
import { accountOrAgentIDfromSessionID } from "../typeUtils/accountOrAgentIDfromSessionID.js";

export function isCurrentNodeSessionOwner(
  local: LocalNode,
  sessionID: SessionID,
): boolean {
  const sessionOwner = accountOrAgentIDfromSessionID(sessionID);
  const currentAccountOrAgentID = local.getCurrentAccountOrAgentID();
  const currentAgentID = local.crypto.getAgentID(local.agentSecret);
  return (
    sessionOwner === currentAccountOrAgentID || sessionOwner === currentAgentID
  );
}

export function transactionsEqual(a: Transaction, b: Transaction): boolean {
  if (a.privacy !== b.privacy || a.madeAt !== b.madeAt) {
    return false;
  }
  if (a.privacy === "private" && b.privacy === "private") {
    return (
      a.keyUsed === b.keyUsed &&
      a.encryptedChanges === b.encryptedChanges &&
      a.meta === b.meta
    );
  }
  if (a.privacy === "trusting" && b.privacy === "trusting") {
    return a.changes === b.changes && a.meta === b.meta;
  }
  return false;
}

export function findCommonPrefixLength(
  localTransactions: Transaction[],
  authoritativeTransactions: Transaction[],
): number {
  const length = Math.min(
    localTransactions.length,
    authoritativeTransactions.length,
  );
  let commonPrefix = 0;
  while (
    commonPrefix < length &&
    transactionsEqual(
      localTransactions[commonPrefix]!,
      authoritativeTransactions[commonPrefix]!,
    )
  ) {
    commonPrefix++;
  }
  return commonPrefix;
}
