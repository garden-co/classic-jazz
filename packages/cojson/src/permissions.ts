import { CoValueCore, VerifiedTransaction } from "./coValueCore/coValueCore.js";
import { RawAccountID } from "./coValues/account.js";
import {
  KeyID,
  NodeCoreImpl,
  NodeCorePendingTx,
  NodeCoreVerdictDelta,
} from "./crypto/crypto.js";
import { AgentID, RawCoID } from "./ids.js";

export type PermissionsDef =
  | { type: "group"; initialAdmin: RawAccountID | AgentID }
  | { type: "ownedByGroup"; group: RawCoID; restrictDeletion?: boolean }
  | { type: "unsafeAllowAll" };

export type AccountRole =
  /**
   * Can read the group's CoValues
   */
  | "reader"
  /**
   * Can read and write to the group's CoValues
   */
  | "writer"
  /**
   * Can read and write to the group, and change group member roles
   */
  | "admin"
  /**
   * Can read and write, invite and revoke members except admin
   */
  | "manager"
  /**
   * Can only write to the group's CoValues and read their own changes
   */
  | "writeOnly";

export type Role =
  | AccountRole
  | "revoked"
  | "managerInvite"
  | "adminInvite"
  | "writerInvite"
  | "readerInvite"
  | "writeOnlyInvite";

export function isAccountRole(role?: Role): role is AccountRole {
  return (
    role === "manager" ||
    role === "admin" ||
    role === "writer" ||
    role === "reader" ||
    role === "writeOnly"
  );
}

export function determineValidTransactions(coValue: CoValueCore): void {
  if (!coValue.isAvailable()) {
    throw new Error("determineValidTransactions CoValue is not available");
  }

  // The native NodeCore validates EVERY ruleset (group, ownedByGroup,
  // unsafeAllowAll). A header missing initialAdmin cannot even
  // deserialize/register natively (fail-closed), so there is no per-ruleset
  // guard and no TS fallback dispatch below this point.
  determineValidTransactionsNative(coValue, coValue.node.nodeCore);
}

/**
 * Native counterpart of the whole {@link determineValidTransactions} dispatch:
 * NodeCore validates EVERY ruleset (group, ownedByGroup, unsafeAllowAll). The
 * registry already holds every transaction (ingested via addTransactions), so
 * `pending` carries ONLY the per-transaction extras native cannot recompute
 * itself:
 *   - `sourceMadeAt`: the TS-derived ordering override for merged/branch
 *     transactions (computed from merge meta in parseMetaInformation).
 *   - `sourceTxId`: the merged transaction's source identity in its branch.
 *   - `metaJson`: decrypted PRIVATE meta available NOW (private meta is not on
 *     the wire, so native can't read it; trusting meta IS wire-visible and must
 *     NOT be sent — native reads it itself).
 *
 * ## Delta protocol (O(new) per pass)
 *
 * `pending` is built over ONLY the transactions this pass owns
 * (`toValidateTransactions`) — NOT the whole history. The native engine keeps
 * each pass's extras resident (a sparse per-CoValue store), so a later full
 * recompute still folds every historical merge/branch tx even though TS supplied
 * pending only for the new ones.
 *
 * Verdicts come back as a DELTA keyed to a per-CoValueCore cursor
 * `{generation, count}`:
 *   - **generation-stable extend** — the engine only APPENDED verdicts since the
 *     cursor; native returns just the tail (`fromIndex === count`). By the
 *     engine's generation contract the prefix TS already applied is byte-for-byte
 *     unchanged, so TS re-marks only the new txs. This holds for the GROUP path
 *     too: a group verdict FLIP can only come from a full recompute, which bumps
 *     the generation — so on a stable generation there is provably nothing to
 *     re-mark on old group txs.
 *   - **generation bump / no cursor** — a recompute may have reordered/flipped
 *     verdicts, so native returns the FULL list (`fromIndex === 0`); TS resets
 *     the cursor and (for a group) re-marks ALL `verifiedTransactions` so a late
 *     revocation's flip reaches already-settled txs.
 *
 * The cursor is invalidated in lockstep with the ONE place the native engine is
 * dropped — {@link CoValueCore.resetParsedTransactions} clears it right where it
 * calls `resetValidation` — so a generation match can never coincide with a
 * stale-but-changed verdict prefix.
 */
function determineValidTransactionsNative(
  coValue: CoValueCore,
  nodeCore: NodeCoreImpl,
): void {
  // Pending is built over the DELTA this pass owns, not the whole history:
  // per-ingest cost stays O(new). A tx contributes an entry only when it has an
  // extra native cannot recompute itself.
  const pending: NodeCorePendingTx[] = [];
  for (const tx of coValue.toValidateTransactions) {
    const entry: NodeCorePendingTx = {
      sessionId: tx.currentTxID.sessionID,
      txIndex: tx.currentTxID.txIndex,
    };
    let hasExtra = false;

    if (tx.sourceTxMadeAt !== undefined) {
      entry.sourceMadeAt = tx.sourceTxMadeAt;
      hasExtra = true;
    }

    if (tx.sourceTxID !== undefined) {
      entry.sourceTxId = {
        sessionID: tx.sourceTxID.sessionID,
        txIndex: tx.sourceTxID.txIndex,
      };
      hasExtra = true;
    }

    // Only PRIVATE meta is passed: it is not on the wire so native cannot read
    // it. `tx.meta` is populated for a private tx only once decrypted; trusting
    // meta is wire-visible and native reads it itself, so it must not be sent.
    if (tx.tx.privacy === "private" && tx.meta !== undefined) {
      entry.metaJson = JSON.stringify(tx.meta);
      hasExtra = true;
    }

    if (hasExtra) {
      pending.push(entry);
    }
  }

  // Missing-dependency error description differs per ruleset, matching the TS
  // fallback: an owned object throws about its owning group, everything else
  // (group parent extensions / owning account) about the parent group.
  const missingDependencyDescription =
    coValue.verified?.header.ruleset.type === "ownedByGroup"
      ? "Determining valid transaction in owned object but its group wasn't loaded"
      : "Expected parent group to be loaded";

  const cursor = coValue.validationCursor;
  let delta: NodeCoreVerdictDelta;
  try {
    delta = nodeCore.validateTransactionsDelta(
      coValue.id,
      cursor?.generation ?? 0,
      cursor?.count ?? 0,
      pending,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("CoValue not loaded: ")) {
      // Dependency (parent group / owning group / owning account) missing from
      // the native registry — route through the canonical TS error path so
      // consumers see the same message the TS implementation produces.
      const missingId = message.slice("CoValue not loaded: ".length) as RawCoID;
      coValue.node.expectCoValueLoaded(missingId, missingDependencyDescription);
    }
    throw e;
  }

  const verdicts = delta.verdicts;
  // A full return (`fromIndex === 0`) means the engine recomputed (verdicts may
  // have been reordered/flipped) or TS had no cursor: reset the cursor and, for
  // a group, apply across ALL history so flips reach already-settled txs.
  const isFullReset = delta.fromIndex === 0;
  coValue.validationCursor = {
    generation: delta.generation,
    count: delta.fromIndex + verdicts.length,
  };

  // The set of transactions a verdict may be applied to:
  //
  //   • group + full reset: re-mark the FULL `verifiedTransactions` history —
  //     the ONLY carrier of a permission FLIP to an already-processed group
  //     transaction (groups never get `resetParsedTransactions`; the flip rides
  //     a full-recompute delta). On a generation-stable extend the returned
  //     delta is only the new txs and old verdicts provably did not change, so
  //     `toValidateTransactions` suffices there.
  //
  //   • ownedByGroup / unsafeAllowAll: always the delta this pass owns
  //     (`coValue.toValidateTransactions`). These carry `fww` meta (produced ONLY
  //     by owned data covalues, never groups). `fww` winner tracking is a TS-only
  //     overlay run AFTER this function that `markInvalid`s a previously-valid tx
  //     when a competing tx arrives; re-applying a permission-only "valid" to an
  //     already-settled tx would clobber it. Their old verdicts flip only on a
  //     group change, which fires `resetParsedTransactions` (→ cursor cleared,
  //     `toValidateTransactions` = ALL), so the delta scope still covers the flip.
  const isGroup = coValue.verified?.header.ruleset.type === "group";
  const applyTo =
    isGroup && isFullReset
      ? coValue.verifiedTransactions // group flip carrier — reaches old txs
      : coValue.toValidateTransactions; // extend / owned / unsafe — delta scope
  const byKey = new Map<string, VerifiedTransaction>();
  for (const tx of applyTo) {
    byKey.set(`${tx.currentTxID.sessionID}/${tx.currentTxID.txIndex}`, tx);
  }
  // Apply IN THE ORDER RUST RETURNS (spec: dispatch order feeds downstream stable sorts)
  for (const v of verdicts) {
    const tx = byKey.get(`${v.sessionId}/${v.txIndex}`);
    if (!tx) continue; // verdict for a tx outside `applyTo` (not in this pass's set, or TS hasn't wrapped it yet)

    if (v.outcome === "validBranchPointerOnly") {
      // Mirror the reader branch-pointer trim in the ownedByGroup path: force
      // changes and meta to only contain the branch pointer information.
      tx.meta = {
        branch: tx.meta?.branch,
        ownerId: tx.meta?.ownerId,
      };
      tx.changes = [];
      tx.markValid();
    } else if (v.outcome === "invalid") {
      tx.markInvalid(v.reason ?? "Invalid transaction", {
        transactor: tx.author,
      });
    } else {
      tx.markValid();
    }
  }
}

export function isKeyForKeyField(co: string): co is `${KeyID}_for_${KeyID}` {
  return co.startsWith("key_") && co.includes("_for_key");
}
