import { base58 } from "@scure/base";
import type { CoID } from "./coValue.js";
import type { RawAccountID } from "./coValues/account.js";
import type { RawGroup } from "./coValues/group.js";
import { shortHashLength } from "./crypto/crypto.js";

export type RawCoID = `co_z${string}`;
export type ParentGroupReference = `parent_${CoID<RawGroup>}`;
export type ChildGroupReference = `child_${CoID<RawGroup>}`;

export function isRawCoID(id: unknown): id is RawCoID {
  return typeof id === "string" && id.startsWith("co_z");
}

export function rawCoIDtoBytes(id: RawCoID): Uint8Array {
  return base58.decode(id.substring("co_z".length));
}

export function rawCoIDfromBytes(bytes: Uint8Array): RawCoID {
  return `co_z${base58.encode(bytes.slice(0, shortHashLength))}` as RawCoID;
}

export type TransactionID = {
  sessionID: SessionID;
  txIndex: number;
  branch?: RawCoID;
};

export type AgentID = `sealer_z${string}/signer_z${string}`;

export function isAgentID(id: unknown): id is AgentID {
  return (
    typeof id === "string" &&
    id.startsWith("sealer_") &&
    id.includes("/signer_")
  );
}

export type ActiveSessionID = `${RawAccountID | AgentID}_session_z${string}`;
export type DeleteSessionID = `${RawAccountID | AgentID}_session_d${string}$`;
export type ConflictSessionID = `${RawAccountID | AgentID}_session_z${string}!`;
export type SessionID = ActiveSessionID | DeleteSessionID | ConflictSessionID;

const CHAR_DOLLAR = "$".charCodeAt(0);
const CHAR_EXCLAMATION = "!".charCodeAt(0);

export function isDeleteSessionID(
  sessionID: SessionID,
): sessionID is DeleteSessionID {
  return sessionID.charCodeAt(sessionID.length - 1) === CHAR_DOLLAR;
}

export function isConflictSessionID(
  sessionID: SessionID,
): sessionID is ConflictSessionID {
  return (
    sessionID.charCodeAt(sessionID.length - 1) === CHAR_EXCLAMATION &&
    sessionID.charCodeAt(sessionID.length - 2) !== CHAR_DOLLAR
  );
}

export function toConflictSessionID(
  sessionID: ActiveSessionID,
): ConflictSessionID {
  return `${sessionID}!` as ConflictSessionID;
}

export function isParentGroupReference(
  key: string,
): key is ParentGroupReference {
  return key.startsWith("parent_");
}

export function getParentGroupId(key: ParentGroupReference): CoID<RawGroup> {
  return key.slice("parent_".length) as CoID<RawGroup>;
}

export function isChildGroupReference(key: string): key is ChildGroupReference {
  return key.startsWith("child_");
}

export function getChildGroupId(key: ChildGroupReference): CoID<RawGroup> {
  return key.slice("child_".length) as CoID<RawGroup>;
}

export function getGroupDependentKey(key: unknown) {
  if (typeof key !== "string") return undefined;

  if (isParentGroupReference(key)) {
    return getParentGroupId(key);
  } else if (key.startsWith("co_")) {
    return key as RawCoID;
  }

  return undefined;
}

export function getGroupDependentKeyList(keys: unknown[]) {
  const groupDependentKeys: RawCoID[] = [];

  for (const key of keys) {
    const value = getGroupDependentKey(key);

    if (value) {
      groupDependentKeys.push(value);
    }
  }

  return groupDependentKeys;
}
