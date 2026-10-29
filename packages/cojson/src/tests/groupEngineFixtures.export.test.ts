/**
 * Group-engine fixture exporter.
 *
 * This vitest suite builds real cojson group/permission state through the public
 * APIs and captures, per scenario:
 *   - the raw wire form of every touched CoValue (header + sessions + transactions
 *     + signerId + lastSignature) so a Rust `SessionMapImpl` can ingest them via
 *     `addTransactions(..., skipVerify)`.
 *   - the permission verdict (valid + reason) for every transaction of the
 *     verdict-bearing CoValues, straight from `determineValidTransactions`.
 *   - time-indexed role queries resolved by `roleOfInternal` / `atTime`.
 *
 * The fixtures are the executable spec for the Rust port of the permission system.
 *
 * When `EXPORT_GROUP_ENGINE_FIXTURES=1` the fixtures are written to
 * `crates/cojson-core/data/group_engine/<scenario>.json`. Regardless of export,
 * the suite always asserts internal consistency so it has value in CI.
 *
 * Oracle inversion (post Part C): the `COJSON_DISABLE_NATIVE_VALIDATION` kill
 * switch is gone, so this exporter no longer captures an INDEPENDENT TS oracle —
 * it captures whatever the native NodeCore produces. The committed fixtures are
 * frozen golden files originating from the TypeScript engine (commit
 * `b84f15310`). They are now the authority; the exporter is only a *regenerator*.
 * Regeneration MUST NOT change verdict CONTENT — only tx/session identities may
 * churn. Any content diff on regeneration is a native-engine regression, not a
 * fixture update. Before landing a change that touches the native engine,
 * regenerate once and diff the previously-kill-switch-forced scenarios
 * (owned_by_group_roles and the reader-branch-pointer / merged-tx cases) against
 * the committed fixtures to confirm the native ownedByGroup engine reproduces
 * `validBranchPointerOnly` and the "Transactor has no write permissions"
 * verdicts byte-for-byte (identities aside).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { expectMap } from "../coValue.js";
import type { CoValueCore } from "../coValueCore/coValueCore.js";
import { ControlledAgent } from "../coValues/account.js";
import { WasmCrypto } from "../crypto/WasmCrypto.js";
import type { RawCoID } from "../ids.js";
import { LocalNode } from "../localNode.js";
import { expectGroup } from "../typeUtils/expectGroup.js";
import {
  createAccountInNode,
  importContentIntoNode,
  newGroupHighLevel,
} from "./testUtils.js";

const Crypto = await WasmCrypto.create();

const EXPORT = process.env.EXPORT_GROUP_ENGINE_FIXTURES === "1";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../crates/cojson-core/data/group_engine",
);

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

type SessionFixture = {
  sessionId: string;
  signerId: string;
  transactions: string[];
  lastSignature: string;
};

type CoValueFixture = {
  coId: string;
  headerJson: string;
  sessions: SessionFixture[];
};

type Verdict = {
  sessionId: string;
  txIndex: number;
  valid: boolean;
  reason: string | null;
  // --- Stage-3 rich-verdict fields (present only for the ownedByGroup /
  // unsafeAllowAll / merged-transaction scenarios; omitted for the original 18
  // group-only fixtures so their bytes stay unchanged) ---
  //
  // Explicit outcome for the Rust port. Absent => derive from `valid`.
  // "validBranchPointerOnly" marks the TS reader-branch-pointer trim
  // (permissions.ts:124-137): a reader tx with meta.branch + meta.ownerId is
  // forced to `meta = {branch, ownerId}`, `changes = []`, then marked valid.
  outcome?: "valid" | "invalid" | "validBranchPointerOnly";
  // Effective (source) madeAt for a merged transaction (VerifiedTransaction
  // .sourceTxMadeAt, derived from merge meta in parseMetaInformation). Omitted
  // for non-merged transactions.
  sourceMadeAt?: number;
  // The source transaction identity used by TS compareTransactions for
  // same-"session" tie-breaks (txID = sourceTxID ?? currentTxID). Omitted for
  // non-merged transactions.
  sourceTxId?: { sessionID: string; txIndex: number };
  // The decrypted meta the TS engine had AT VALIDATION TIME, or null when it
  // was unavailable (e.g. a received private transaction validates with
  // meta === undefined, before decryption — the pipeline-order contract).
  metaJson?: string | null;
};

type RoleQueryInput = {
  groupId: RawCoID;
  member: string;
  atTime: number | null;
};

type RoleQueryResult = RoleQueryInput & { expectedRole: string | null };

type Fixture = {
  description: string;
  covalues: CoValueFixture[];
  verdicts: Record<string, Verdict[]>;
  roleQueries: RoleQueryResult[];
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function readCoValue(
  node: LocalNode,
  id: RawCoID,
  rich = false,
): CoValueFixture {
  const core = node.getCoValue(id);
  if (!core.verified) {
    throw new Error(`CoValue ${id} is not available`);
  }
  // Force parsing so verified state / session logs are fully materialised. For
  // rich (Stage-3) scenarios we keep private transactions undecrypted so that a
  // received private transaction's meta stays `undefined` at validation time
  // (the pipeline-order contract). Either way the exported wire form — raw
  // encrypted transactions, signerId, lastSignature — is identical.
  core.getValidTransactions({ ignorePrivateTransactions: rich });

  const nc = node.nodeCore;
  const headerJson = nc.getHeader(id);

  const sessions: SessionFixture[] = nc.getSessionIds(id).map((sessionId) => {
    const rawTxs = nc.getSessionTransactions(id, sessionId, 0) ?? [];
    const transactions = rawTxs.map((tx) => JSON.stringify(tx));
    const lastSignature = nc.getLastSignature(id, sessionId);
    // signerID is served from the in-memory session-log cache, which is
    // populated when transactions are authored/imported in this same node.
    const signerId = core.verified!.getSession(sessionId as any)?.signerID;

    if (transactions.length === 0) {
      throw new Error(`Session ${sessionId} of ${id} has no transactions`);
    }
    if (!signerId) {
      throw new Error(`Missing signerId for ${id} / ${sessionId}`);
    }
    if (!lastSignature) {
      throw new Error(`Missing lastSignature for ${id} / ${sessionId}`);
    }

    return { sessionId, signerId, transactions, lastSignature };
  });

  return { coId: id, headerJson, sessions };
}

/**
 * Resolves the author's role in the OWNING group at a transaction's
 * currentMadeAt — approximating the lookup the ownedByGroup branch performs
 * (permissions.ts:104-107). CAVEAT: unlike production, this skips the
 * `agentInAccountOrMemberInGroup` account→agent resolution; the two coincide
 * except for an ACCOUNT-owned covalue whose transactor is the account itself
 * (always admin, so never a reader-trim) — a stage-4 author adding an
 * account-owned branch-pointer scenario must revisit this. Returns undefined
 * when the covalue is not group-owned or the group cannot be resolved.
 */
function roleOfAuthorAtTxTime(
  core: CoValueCore,
  t: { author: string; currentMadeAt: number },
): string | null | undefined {
  try {
    const group = core.safeGetGroup();
    if (!group) {
      return undefined;
    }
    return (
      group.atTime(t.currentMadeAt).roleOfInternal(t.author as any) ?? null
    );
  } catch {
    // A throw is treated as "not a reader" and silently DOWNGRADES a would-be
    // validBranchPointerOnly outcome to plain "valid" — scenarios relying on
    // the trim outcome must pin it with an explicit expect() (scenario 22 does).
    return undefined;
  }
}

function readVerdicts(node: LocalNode, id: RawCoID, rich = false): Verdict[] {
  const core = node.getCoValue(id);
  core.getValidTransactions({ ignorePrivateTransactions: rich });

  return core.verifiedTransactions.map((t) => {
    const base: Verdict = {
      sessionId: t.currentTxID.sessionID,
      txIndex: t.currentTxID.txIndex,
      valid: t.isValid,
      reason: t.validationErrorMessage ?? null,
    };

    if (!rich) {
      return base;
    }

    const meta = t.meta as { branch?: unknown; ownerId?: unknown } | undefined;
    // The reader-branch-pointer trim (permissions.ts:124-137) is the path that
    // leaves a VALID transaction with meta {branch, ownerId} and empty changes.
    // It fires ONLY when the author's role at the tx's currentMadeAt is
    // `reader`; an admin/writer branch pointer is valid via write permissions
    // and carries the same shape, so we must confirm the reader role to avoid a
    // false positive (see the merged-branch scenario, where the admin's own
    // branch pointer is a locally-created private tx with visible meta).
    const hasBranchMeta =
      t.isValid &&
      !!meta &&
      meta.branch !== undefined &&
      meta.ownerId !== undefined &&
      Array.isArray(t.changes) &&
      t.changes.length === 0;
    const isBranchPointerTrim =
      hasBranchMeta && roleOfAuthorAtTxTime(core, t) === "reader";

    base.outcome = isBranchPointerTrim
      ? "validBranchPointerOnly"
      : t.isValid
        ? "valid"
        : "invalid";

    if (t.sourceTxMadeAt !== undefined) {
      base.sourceMadeAt = t.sourceTxMadeAt;
    }
    if (t.sourceTxID !== undefined) {
      base.sourceTxId = {
        sessionID: t.sourceTxID.sessionID,
        txIndex: t.sourceTxID.txIndex,
      };
    }
    base.metaJson = t.meta === undefined ? null : JSON.stringify(t.meta);

    return base;
  });
}

function readRoleQueries(
  node: LocalNode,
  queries: RoleQueryInput[],
): RoleQueryResult[] {
  return queries.map((q) => {
    const core = node.expectCoValueLoaded(q.groupId);
    const g = expectGroup(core.getCurrentContent());
    const view = q.atTime === null ? g : g.atTime(q.atTime);
    const expectedRole = view.roleOfInternal(q.member as any) ?? null;
    return { ...q, expectedRole };
  });
}

function exportScenario(
  name: string,
  node: LocalNode,
  opts: {
    description: string;
    covalueIds: RawCoID[];
    verdictIds: RawCoID[];
    roleQueries: RoleQueryInput[];
    // Stage-3 scenarios: emit the extended verdict fields (outcome / merge
    // metadata / validation-time meta) and keep private transactions
    // undecrypted. Left off for the original 18 group-only fixtures.
    rich?: boolean;
  },
): Fixture {
  const rich = opts.rich ?? false;
  const covalues = opts.covalueIds.map((id) => readCoValue(node, id, rich));

  const verdicts: Record<string, Verdict[]> = {};
  for (const id of opts.verdictIds) {
    verdicts[id] = readVerdicts(node, id, rich);
  }

  const roleQueries = readRoleQueries(node, opts.roleQueries);

  const fixture: Fixture = {
    description: opts.description,
    covalues,
    verdicts,
    roleQueries,
  };

  // --- ALWAYS-ON internal consistency assertions (value in CI) ---
  expect(covalues.length).toBeGreaterThan(0);
  const covIds = new Set(covalues.map((c) => c.coId));
  for (const id of opts.verdictIds) {
    expect(verdicts[id]!.length).toBeGreaterThan(0);
    expect(covIds.has(id)).toBe(true);
  }
  for (const q of roleQueries) {
    expect(covIds.has(q.groupId)).toBe(true);
  }
  // every session must round-trip the pieces a Rust SessionMap needs
  for (const c of covalues) {
    expect(c.headerJson.length).toBeGreaterThan(0);
    for (const s of c.sessions) {
      expect(s.transactions.length).toBeGreaterThan(0);
      expect(s.signerId.length).toBeGreaterThan(0);
      expect(s.lastSignature.length).toBeGreaterThan(0);
    }
  }

  if (EXPORT) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, `${name}.json`),
      JSON.stringify(fixture, null, 2),
    );
  }

  return fixture;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshAgent() {
  const secret = Crypto.newRandomAgentSecret();
  const id = Crypto.getAgentID(secret);
  return { secret, id, controlled: new ControlledAgent(secret, Crypto) };
}

function keyId() {
  return Crypto.newRandomKeySecret().id;
}

/**
 * Runs `fn` against the group content as authored by `account` (a different
 * account/agent), then imports the resulting session(s) back into `node` so the
 * master node accumulates every session of every author on one CoValue.
 */
async function actAs(
  node: LocalNode,
  coId: RawCoID,
  account: ControlledAgent | any,
  fn: (group: ReturnType<typeof expectGroup>) => void,
) {
  const core = node.getCoValue(coId);
  const content = await core.contentInClonedNodeWithDifferentAccount(account);
  const group = expectGroup(content);
  fn(group);
  importContentIntoNode(group.core, node);
}

/**
 * Like {@link actAs}, but authors transaction(s) directly on an arbitrary
 * CoValue (e.g. a map owned by a group) as `account`, then imports the produced
 * session back into `node`. `fn` receives the CoValueCore in the cloned node so
 * it can craft raw transactions the way the public APIs would.
 */
async function actAsOnCoValue(
  node: LocalNode,
  coId: RawCoID,
  account: ControlledAgent | any,
  fn: (core: CoValueCore) => void,
) {
  const core = node.getCoValue(coId);
  const content = await core.contentInClonedNodeWithDifferentAccount(account);
  fn(content.core);
  importContentIntoNode(content.core, node);
}

function verdictReasons(fixture: Fixture, id: string): (string | null)[] {
  return (fixture.verdicts[id] ?? []).map((v) => v.reason);
}

function hasInvalid(fixture: Fixture, id: string, reason: string) {
  expect(verdictReasons(fixture, id)).toContain(reason);
}

function hasValid(fixture: Fixture, id: string) {
  expect((fixture.verdicts[id] ?? []).some((v) => v.valid)).toBe(true);
}

// A group node whose admin is a plain agent (no admin account CoValue).
function newLowLevelGroup() {
  const adminSecret = Crypto.newRandomAgentSecret();
  const sessionID = Crypto.newRandomSessionID(Crypto.getAgentID(adminSecret));
  const node = new LocalNode(adminSecret, sessionID, Crypto);
  const groupCore = node.createCoValue({
    type: "comap",
    ruleset: { type: "group", initialAdmin: node.getCurrentAgent().id },
    meta: null,
    ...Crypto.createdNowUnique(),
  });
  return { node, groupCore, adminID: node.getCurrentAgent().id };
}

// ===========================================================================
// Scenarios
// ===========================================================================

describe("group engine fixtures", () => {
  // 1. basic_roles ----------------------------------------------------------
  test("basic_roles", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const { node, group } = newGroupHighLevel();

      const reader = createAccountInNode(node);
      const writer = createAccountInNode(node);
      const writeOnly = createAccountInNode(node);
      const manager = createAccountInNode(node);

      vi.setSystemTime(1_700_000_010_000);
      group.addMember(reader, "reader" as any);
      const tReader = Date.now();

      vi.setSystemTime(1_700_000_020_000);
      group.addMember(writer, "writer" as any);
      const tWriter = Date.now();

      vi.setSystemTime(1_700_000_030_000);
      group.addMember(writeOnly, "writeOnly" as any);
      const tWriteOnly = Date.now();

      vi.setSystemTime(1_700_000_040_000);
      group.addMember(manager, "manager" as any);
      const tManager = Date.now();

      // role change over time: reader is promoted to writer later
      vi.setSystemTime(1_700_000_050_000);
      group.addMember(reader, "writer" as any);
      const tReaderPromoted = Date.now();

      const fixture = exportScenario("basic_roles", node, {
        description:
          "admin adds reader/writer/writeOnly/manager; a role changes over time",
        covalueIds: [group.id, reader.id, writer.id, writeOnly.id, manager.id],
        verdictIds: [group.id],
        roleQueries: [
          // between reader-add and reader-promotion → reader
          { groupId: group.id, member: reader.id, atTime: tWriter },
          // after promotion → writer
          { groupId: group.id, member: reader.id, atTime: tReaderPromoted },
          // latest → writer
          { groupId: group.id, member: reader.id, atTime: null },
          { groupId: group.id, member: writer.id, atTime: tWriter },
          { groupId: group.id, member: writeOnly.id, atTime: tWriteOnly },
          { groupId: group.id, member: manager.id, atTime: tManager },
          // before any membership existed → undefined
          { groupId: group.id, member: writer.id, atTime: tReader },
        ],
      });

      hasValid(fixture, group.id);
      // reader was reader at tWriter, writer after promotion
      const q = fixture.roleQueries;
      expect(q[0]!.expectedRole).toBe("reader");
      expect(q[1]!.expectedRole).toBe("writer");
      expect(q[2]!.expectedRole).toBe("writer");
      expect(q[3]!.expectedRole).toBe("writer");
      expect(q[4]!.expectedRole).toBe("writeOnly");
      expect(q[5]!.expectedRole).toBe("manager");
      expect(q[6]!.expectedRole).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  // 2. initial_admin_self_promotion ----------------------------------------
  test("initial_admin_self_promotion", async () => {
    const { node, groupCore, adminID } = newLowLevelGroup();
    const group = expectGroup(groupCore.getCurrentContent());

    // first transaction of the group is the initial-admin self-promotion.
    // NOTE on the two `as any` idioms in this file: `(group.set as any)(...)`
    // (method cast) is used where the KEY is dynamic — GroupShape's overlapping
    // index signatures collapse the generic value type to `never` for
    // non-literal keys; `value as any` (argument cast) suffices where the key
    // is a known literal and only the value type is off.
    (group.set as any)(adminID, "admin", "trusting");

    // a non-initialAdmin attempting the very same self-promotion → invalid
    const other = freshAgent();
    await actAs(node, groupCore.id, other.controlled, (g) => {
      (g.set as any)(other.id, "admin", "trusting");
    });

    const fixture = exportScenario("initial_admin_self_promotion", node, {
      description:
        "fresh group whose first tx is the initial-admin self-promotion; a non-initialAdmin self-promotion is rejected",
      covalueIds: [groupCore.id],
      verdictIds: [groupCore.id],
      roleQueries: [
        { groupId: groupCore.id, member: adminID, atTime: null },
        { groupId: groupCore.id, member: other.id, atTime: null },
      ],
    });

    hasValid(fixture, groupCore.id);
    hasInvalid(
      fixture,
      groupCore.id,
      "Group transaction must be made by current admin, manager, or invite",
    );
    expect(fixture.roleQueries[0]!.expectedRole).toBe("admin");
    expect(fixture.roleQueries[1]!.expectedRole).toBe(null);
  });

  // 3. self_revoke ----------------------------------------------------------
  test("self_revoke", async () => {
    const { node, group } = newGroupHighLevel();
    const reader = createAccountInNode(node);
    group.addMember(reader, "reader" as any);

    // reader revokes themselves — valid even without admin role
    await actAs(node, group.id, reader, (g) => {
      (g.set as any)(reader.id, "revoked", "trusting");
    });

    const fixture = exportScenario("self_revoke", node, {
      description:
        "a member revokes their own access (valid without admin role)",
      covalueIds: [group.id, reader.id],
      verdictIds: [group.id],
      roleQueries: [{ groupId: group.id, member: reader.id, atTime: null }],
    });

    // the self-revoke tx (authored by reader) must be valid
    const readerVerdicts = fixture.verdicts[group.id]!.filter((v) =>
      v.sessionId.startsWith(reader.id),
    );
    expect(readerVerdicts.some((v) => v.valid)).toBe(true);
    expect(fixture.roleQueries[0]!.expectedRole).toBe(null);
  });

  // 4. all_invites ----------------------------------------------------------
  test("all_invites", async () => {
    const { node, group } = newGroupHighLevel();

    const cases: {
      kind: string;
      correct: string;
      wrong: string;
      wrongReason: string;
    }[] = [
      {
        kind: "adminInvite",
        correct: "admin",
        wrong: "manager",
        wrongReason: "AdminInvites can only create admins.",
      },
      {
        kind: "managerInvite",
        correct: "manager",
        wrong: "writer",
        wrongReason: "managerInvite can only create managers.",
      },
      {
        kind: "writerInvite",
        correct: "writer",
        wrong: "reader",
        wrongReason: "WriterInvites can only create writers.",
      },
      {
        kind: "readerInvite",
        correct: "reader",
        wrong: "writer",
        wrongReason: "ReaderInvites can only create reader.",
      },
      {
        kind: "writeOnlyInvite",
        correct: "writeOnly",
        wrong: "reader",
        wrongReason: "WriteOnlyInvites can only create writeOnly.",
      },
    ];

    for (const c of cases) {
      const invite = freshAgent();
      (group.set as any)(invite.id, c.kind, "trusting");

      const correctTarget = freshAgent();
      const wrongTarget = freshAgent();

      await actAs(node, group.id, invite.controlled, (g) => {
        (g.set as any)(correctTarget.id, c.correct, "trusting"); // valid
        (g.set as any)(wrongTarget.id, c.wrong, "trusting"); // invalid
      });
    }

    const fixture = exportScenario("all_invites", node, {
      description:
        "each invite kind accepts exactly its role (valid) and rejects any other role (invalid, with exact reason)",
      covalueIds: [group.id],
      verdictIds: [group.id],
      roleQueries: [],
    });

    for (const c of cases) {
      hasInvalid(fixture, group.id, c.wrongReason);
    }
    hasValid(fixture, group.id);
  });

  // 5. admin_demotion_rules -------------------------------------------------
  test("admin_demotion_rules", async () => {
    const { node, group, admin } = newGroupHighLevel();
    const otherAdmin = createAccountInNode(node);
    const writer = createAccountInNode(node);

    group.addMember(otherAdmin, "admin" as any);
    group.addMember(writer, "writer" as any);

    // admin demotes another admin → invalid
    (group.set as any)(otherAdmin.id, "writer", "trusting");
    // admin demotes a writer → valid
    (group.set as any)(writer.id, "reader", "trusting");
    // admin demotes self → valid (must be last, self loses admin afterwards)
    (group.set as any)(admin.id, "writer", "trusting");

    const fixture = exportScenario("admin_demotion_rules", node, {
      description:
        "admin cannot demote another admin, but can demote a writer and demote self",
      covalueIds: [group.id, otherAdmin.id, writer.id],
      verdictIds: [group.id],
      roleQueries: [
        { groupId: group.id, member: otherAdmin.id, atTime: null },
        { groupId: group.id, member: writer.id, atTime: null },
      ],
    });

    hasInvalid(fixture, group.id, "Admins can't demote admins.");
    // other admin stays admin (demotion rejected), writer became reader
    expect(fixture.roleQueries[0]!.expectedRole).toBe("admin");
    expect(fixture.roleQueries[1]!.expectedRole).toBe("reader");
  });

  // 6. manager_rules --------------------------------------------------------
  test("manager_rules", async () => {
    const { node, group } = newGroupHighLevel();
    const manager = createAccountInNode(node);
    const otherAdmin = createAccountInNode(node);
    group.addMember(manager, "manager" as any);
    group.addMember(otherAdmin, "admin" as any);

    const promoteTarget = freshAgent();
    const adminInviteTarget = freshAgent();
    const managerInviteTarget = freshAgent();
    const writerTarget = freshAgent();

    await actAs(node, group.id, manager, (g) => {
      (g.set as any)(otherAdmin.id, "writer", "trusting"); // demote admin → invalid
      (g.set as any)(promoteTarget.id, "admin", "trusting"); // promote to admin → invalid
      (g.set as any)(adminInviteTarget.id, "adminInvite", "trusting"); // invite admin → invalid
      (g.set as any)(managerInviteTarget.id, "managerInvite", "trusting"); // invite manager → invalid
      (g.set as any)(writerTarget.id, "writer", "trusting"); // add writer → valid
    });

    const fixture = exportScenario("manager_rules", node, {
      description:
        "manager cannot demote admins, promote to admin, or invite admins/managers, but can add a writer",
      covalueIds: [group.id, manager.id, otherAdmin.id],
      verdictIds: [group.id],
      roleQueries: [
        { groupId: group.id, member: writerTarget.id, atTime: null },
      ],
    });

    hasInvalid(fixture, group.id, "Managers can't demote admins.");
    hasInvalid(fixture, group.id, "Managers can't promote to admin.");
    hasInvalid(fixture, group.id, "Managers can't invite admins.");
    hasInvalid(fixture, group.id, "Managers can't invite managers.");
    expect(fixture.roleQueries[0]!.expectedRole).toBe("writer");
  });

  // 7. write_only_keys ------------------------------------------------------
  test("write_only_keys", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const { node, group } = newGroupHighLevel();

      const writeOnly = freshAgent();
      const invite = freshAgent();

      const k1 = keyId();
      const k2 = keyId();
      const k3 = keyId();

      // give the members roles
      vi.setSystemTime(1_700_000_001_000);
      (group.set as any)(writeOnly.id, "writeOnly", "trusting");
      vi.setSystemTime(1_700_000_002_000);
      (group.set as any)(invite.id, "writeOnlyInvite", "trusting");

      // (a) writeOnly member sets their OWN write key first → valid
      vi.setSystemTime(1_700_000_003_000);
      await actAs(node, group.id, writeOnly.controlled, (g) => {
        (g.set as any)(`writeKeyFor_${writeOnly.id}`, k1, "trusting");
      });

      // (b) a writeOnlyInvite tries to override the existing write key → invalid
      vi.setSystemTime(1_700_000_004_000);
      await actAs(node, group.id, invite.controlled, (g) => {
        (g.set as any)(`writeKeyFor_${writeOnly.id}`, k2, "trusting");
      });

      // (c) an admin overrides the existing write key → valid
      vi.setSystemTime(1_700_000_005_000);
      (group.set as any)(`writeKeyFor_${writeOnly.id}`, k3, "trusting");

      // (d) writeOnly member reveals their own write key secret → valid
      vi.setSystemTime(1_700_000_006_000);
      await actAs(node, group.id, writeOnly.controlled, (g) => {
        (g.set as any)(
          `${k3}_for_${writeOnly.id}`,
          "revelation_dummy",
          "trusting",
        );
      });

      const fixture = exportScenario("write_only_keys", node, {
        description:
          "writeOnly member sets own write key (valid); invite override (invalid); admin override (valid); own write-key revelation (valid)",
        covalueIds: [group.id],
        verdictIds: [group.id],
        roleQueries: [
          { groupId: group.id, member: writeOnly.id, atTime: null },
        ],
      });

      hasInvalid(
        fixture,
        group.id,
        "Write key already exists and can't be overridden by invite",
      );
      hasValid(fixture, group.id);
      expect(fixture.roleQueries[0]!.expectedRole).toBe("writeOnly");
    } finally {
      vi.useRealTimers();
    }
  });

  // 8. key_revelations ------------------------------------------------------
  test("key_revelations", async () => {
    const { node, group } = newGroupHighLevel();
    const writer = createAccountInNode(node);
    group.addMember(writer, "writer" as any);

    const targetAcct = createAccountInNode(node);
    const rk = keyId();

    // admin can set the group-level key fields
    group.set("readKey", rk, "trusting");
    group.set("groupSealer", "sealer_zDUMMYGROUPSEALER" as any, "trusting");
    group.set("profile", "co_zDUMMYPROFILE" as any, "trusting");
    group.set("root", "co_zDUMMYROOT" as any, "trusting");
    // admin can reveal a key_for field
    (group.set as any)(
      `${rk}_for_${targetAcct.id}`,
      "revelation_admin",
      "trusting",
    );

    // writer cannot set any of the admin-only key fields
    await actAs(node, group.id, writer, (g) => {
      g.set("readKey", keyId(), "trusting");
      g.set("groupSealer", "sealer_zDUMMY2" as any, "trusting");
      g.set("profile", "co_zDUMMY2" as any, "trusting");
      g.set("root", "co_zDUMMY2" as any, "trusting");
    });

    // each invite kind can reveal key_for fields
    for (const kind of [
      "adminInvite",
      "managerInvite",
      "writerInvite",
      "readerInvite",
      "writeOnlyInvite",
    ]) {
      const invite = freshAgent();
      (group.set as any)(invite.id, kind, "trusting");
      const revealTarget = freshAgent();
      await actAs(node, group.id, invite.controlled, (g) => {
        (g.set as any)(
          `${rk}_for_${revealTarget.id}`,
          `revelation_${kind}`,
          "trusting",
        );
      });
    }

    const fixture = exportScenario("key_revelations", node, {
      description:
        "readKey/groupSealer/profile/root and key_for reveals: admin & invites allowed, writer rejected",
      covalueIds: [group.id, writer.id, targetAcct.id],
      verdictIds: [group.id],
      roleQueries: [],
    });

    hasInvalid(fixture, group.id, "Only admins can set readKeys");
    hasInvalid(fixture, group.id, "Only admins can set groupSealer");
    hasInvalid(fixture, group.id, "Only admins can set profile");
    hasInvalid(fixture, group.id, "Only admins can set root");
    hasValid(fixture, group.id);
  });

  // 9. everyone_roles -------------------------------------------------------
  test("everyone_roles", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const { node, group } = newGroupHighLevel();
      const plainMember = createAccountInNode(node);

      vi.setSystemTime(1_700_000_001_000);
      group.set("everyone", "reader", "trusting");
      const tReader = Date.now();

      vi.setSystemTime(1_700_000_002_000);
      group.set("everyone", "writer", "trusting");
      const tWriter = Date.now();

      vi.setSystemTime(1_700_000_003_000);
      group.set("everyone", "writeOnly", "trusting");

      vi.setSystemTime(1_700_000_004_000);
      group.set("everyone", "revoked", "trusting");
      const tRevoked = Date.now();

      // invalid: everyone can't be admin
      vi.setSystemTime(1_700_000_005_000);
      group.set("everyone", "admin", "trusting");

      const fixture = exportScenario("everyone_roles", node, {
        description:
          "everyone set to reader/writer/writeOnly/revoked (valid) and admin (invalid); everyone fallback for non-members",
        covalueIds: [group.id, plainMember.id],
        verdictIds: [group.id],
        roleQueries: [
          // plainMember has no direct role → falls back to everyone at that time
          { groupId: group.id, member: plainMember.id, atTime: tReader },
          { groupId: group.id, member: plainMember.id, atTime: tWriter },
          // after everyone is revoked → no fallback → undefined
          { groupId: group.id, member: plainMember.id, atTime: tRevoked },
          // querying "everyone" itself never uses the fallback branch
          { groupId: group.id, member: "everyone", atTime: tWriter },
          { groupId: group.id, member: "everyone", atTime: tRevoked },
        ],
      });

      hasInvalid(
        fixture,
        group.id,
        "Everyone can only be set to reader, writer, writeOnly or revoked",
      );
      const q = fixture.roleQueries;
      expect(q[0]!.expectedRole).toBe("reader");
      expect(q[1]!.expectedRole).toBe("writer");
      expect(q[2]!.expectedRole).toBe(null);
      expect(q[3]!.expectedRole).toBe("writer");
      // "everyone" direct role at revoked time → revoked collapses to null via get? pinned below
      // (recorded as whatever roleOfInternal("everyone") returns)
    } finally {
      vi.useRealTimers();
    }
  });

  // 10. parent_extend -------------------------------------------------------
  test("parent_extend", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const { node } = newGroupHighLevel();
      const parent = node.createGroup();
      const child = node.createGroup();

      vi.setSystemTime(1_700_000_001_000);
      child.extend(parent);
      const tExtended = Date.now();

      const member = createAccountInNode(node);
      vi.setSystemTime(1_700_000_002_000);
      parent.addMember(member, "writer" as any);
      const tMemberAdded = Date.now();

      const fixture = exportScenario("parent_extend", node, {
        description:
          "child group extends a parent; a parent member inherits their role in the child",
        covalueIds: [child.id, parent.id, member.id],
        verdictIds: [child.id, parent.id],
        roleQueries: [
          // before member was added to parent → no inherited role
          { groupId: child.id, member: member.id, atTime: tExtended },
          // after member added → inherits writer through the parent
          { groupId: child.id, member: member.id, atTime: tMemberAdded },
          { groupId: child.id, member: member.id, atTime: null },
          { groupId: parent.id, member: member.id, atTime: null },
        ],
      });

      const q = fixture.roleQueries;
      expect(q[0]!.expectedRole).toBe(null);
      expect(q[1]!.expectedRole).toBe("writer");
      expect(q[2]!.expectedRole).toBe("writer");
      expect(q[3]!.expectedRole).toBe("writer");
    } finally {
      vi.useRealTimers();
    }
  });

  // 11. parent_capped -------------------------------------------------------
  test("parent_capped", async () => {
    const { node } = newGroupHighLevel();
    const parent = node.createGroup();
    const child = node.createGroup();

    const member = createAccountInNode(node);
    parent.addMember(member, "admin" as any);

    // cap the inherited role to writer
    child.extend(parent, "writer");

    const fixture = exportScenario("parent_capped", node, {
      description:
        "parent extension caps the inherited role: a parent admin is capped to writer in the child",
      covalueIds: [child.id, parent.id, member.id],
      verdictIds: [child.id, parent.id],
      roleQueries: [
        { groupId: parent.id, member: member.id, atTime: null },
        { groupId: child.id, member: member.id, atTime: null },
      ],
    });

    expect(fixture.roleQueries[0]!.expectedRole).toBe("admin");
    expect(fixture.roleQueries[1]!.expectedRole).toBe("writer");
  });

  // 12. parent_revoked_inheritance -----------------------------------------
  test("parent_revoked_inheritance", async () => {
    const { node } = newGroupHighLevel();
    const parent = node.createGroup();
    const child = node.createGroup();

    child.extend(parent);

    const member = createAccountInNode(node);
    // member is reader in the child, revoked in the parent
    child.addMember(member, "reader" as any);
    parent.addMember(member, "reader" as any);
    await parent.removeMember(member); // sets revoked in parent

    const fixture = exportScenario("parent_revoked_inheritance", node, {
      description:
        "member is reader in child and revoked in parent (extend mapping); pins the read-side override behaviour",
      covalueIds: [child.id, parent.id, member.id],
      verdictIds: [child.id, parent.id],
      roleQueries: [
        { groupId: parent.id, member: member.id, atTime: null },
        { groupId: child.id, member: member.id, atTime: null },
      ],
    });

    // pin whatever TS resolves (do not presume) — just assert it is recorded
    expect(fixture.roleQueries.length).toBe(2);
  });

  // 13. deep_parent_chain ---------------------------------------------------
  test("deep_parent_chain", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const { node } = newGroupHighLevel();
      const grandparent = node.createGroup();
      const parent = node.createGroup();
      const child = node.createGroup();

      vi.setSystemTime(1_700_000_001_000);
      parent.extend(grandparent);
      child.extend(parent);

      const member = createAccountInNode(node);
      vi.setSystemTime(1_700_000_002_000);
      grandparent.addMember(member, "writer" as any);
      const tAdded = Date.now();

      // mid-chain revocation: revoke the member in the parent
      vi.setSystemTime(1_700_000_003_000);
      parent.addMember(member, "reader" as any);
      vi.setSystemTime(1_700_000_004_000);
      await parent.removeMember(member);
      const tRevoked = Date.now();

      const fixture = exportScenario("deep_parent_chain", node, {
        description:
          "3-level chain (grandparent -> parent -> child) with a mid-chain revocation and time-based queries",
        covalueIds: [child.id, parent.id, grandparent.id, member.id],
        verdictIds: [child.id, parent.id, grandparent.id],
        roleQueries: [
          { groupId: child.id, member: member.id, atTime: tAdded },
          { groupId: child.id, member: member.id, atTime: tRevoked },
          { groupId: child.id, member: member.id, atTime: null },
          { groupId: grandparent.id, member: member.id, atTime: null },
        ],
      });

      // pins whatever TS resolves at each point in time
      expect(fixture.roleQueries.length).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // 14. self_extension_cycle ------------------------------------------------
  test("self_extension_cycle", () => {
    const { node, group } = newGroupHighLevel();

    // raw self-extension (the high-level extend() short-circuits self-extension)
    (group.set as any)(`parent_${group.id}`, "extend", "trusting");

    const fixture = exportScenario("self_extension_cycle", node, {
      description: "a group cannot extend itself (circular dependency)",
      covalueIds: [group.id],
      verdictIds: [group.id],
      roleQueries: [],
    });

    hasInvalid(fixture, group.id, "Parent group is a circular dependency");
  });

  // 15. account_agent_resolution -------------------------------------------
  test("account_agent_resolution", async () => {
    const { node, accountID } = await LocalNode.withNewlyCreatedAccount({
      peers: [],
      crypto: Crypto,
      creationProps: { name: "Resolver" },
    });

    // a CoValue owned directly by the account; its transaction author is the
    // account id, so validation runs agentInAccountOrMemberInGroup.
    const owned = node.createCoValue({
      type: "comap",
      ruleset: { type: "ownedByGroup", group: accountID! },
      meta: null,
      ...Crypto.createdNowUnique(),
    });
    const ownedMap = expectMap(owned.getCurrentContent());
    ownedMap.set("foo", "bar", "trusting");

    const fixture = exportScenario("account_agent_resolution", node, {
      description:
        "a CoValue owned by an account: the account-id transactor is resolved to its agent; account self-role is admin",
      covalueIds: [owned.id, accountID!],
      verdictIds: [owned.id, accountID!],
      roleQueries: [{ groupId: accountID!, member: accountID!, atTime: null }],
    });

    expect(fixture.roleQueries[0]!.expectedRole).toBe("admin");
    hasValid(fixture, owned.id);
    await node.gracefulShutdown();
  });

  // 16. malformed_changes ---------------------------------------------------
  test("malformed_changes", () => {
    const { node, group } = newGroupHighLevel();
    const target = freshAgent();

    // two changes in one transaction
    group.core.makeTransaction(
      [
        { op: "set", key: target.id, value: "reader" },
        { op: "set", key: freshAgent().id, value: "reader" },
      ],
      "trusting",
    );
    // an op that isn't "set"
    group.core.makeTransaction([{ op: "del", key: target.id }], "trusting");
    // an invalid role value
    group.core.makeTransaction(
      [{ op: "set", key: target.id, value: "superadmin" }],
      "trusting",
    );
    // everyone with an invalid role
    group.core.makeTransaction(
      [{ op: "set", key: "everyone", value: "admin" }],
      "trusting",
    );

    const fixture = exportScenario("malformed_changes", node, {
      description:
        "malformed group transactions: multiple changes, non-set op, invalid role value, everyone with invalid role",
      covalueIds: [group.id],
      verdictIds: [group.id],
      roleQueries: [],
    });

    hasInvalid(
      fixture,
      group.id,
      "Group transaction must have exactly one change",
    );
    hasInvalid(
      fixture,
      group.id,
      "Group transaction must set a role or readKey",
    );
    hasInvalid(fixture, group.id, "Group transaction must set a valid role");
    hasInvalid(
      fixture,
      group.id,
      "Everyone can only be set to reader, writer, writeOnly or revoked",
    );
  });

  // 17. cross_session_ties --------------------------------------------------
  test("cross_session_ties", async () => {
    vi.useFakeTimers();
    try {
      // freeze time so every transaction shares the same madeAt
      vi.setSystemTime(1_700_000_000_000);
      const { node, group } = newGroupHighLevel();

      const adminA = createAccountInNode(node);
      const adminB = createAccountInNode(node);
      group.addMember(adminA, "admin" as any);
      group.addMember(adminB, "admin" as any);

      const target = freshAgent();

      // two different admins assign conflicting roles at the SAME madeAt
      await actAs(node, group.id, adminA, (g) => {
        (g.set as any)(target.id, "writer", "trusting");
      });
      await actAs(node, group.id, adminB, (g) => {
        (g.set as any)(target.id, "reader", "trusting");
      });

      const fixture = exportScenario("cross_session_ties", node, {
        description:
          "two sessions of different admins assign conflicting roles with equal madeAt; pins the stable-order outcome",
        covalueIds: [group.id, adminA.id, adminB.id],
        verdictIds: [group.id],
        roleQueries: [{ groupId: group.id, member: target.id, atTime: null }],
      });

      // both conflicting sets are individually valid; the resolved role is pinned
      hasValid(fixture, group.id);
      expect(["writer", "reader"]).toContain(
        fixture.roleQueries[0]!.expectedRole,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // 18. private_tx_in_group -------------------------------------------------
  test("private_tx_in_group", async () => {
    const { node, accountID } = await LocalNode.withNewlyCreatedAccount({
      peers: [],
      crypto: Crypto,
      creationProps: { name: "Priv" },
    });

    const group = node.createGroup();
    const target = freshAgent();

    // a private transaction on a group → always invalid
    group.core.makeTransaction(
      [{ op: "set", key: target.id, value: "reader" }],
      "private",
    );

    // a private transaction on the account CoValue → takes the non-group branch
    const accountCore = node.getCoValue(accountID!);
    accountCore.makeTransaction(
      [{ op: "set", key: "profile", value: "co_zDUMMYPROFILE" }],
      "private",
    );

    const fixture = exportScenario("private_tx_in_group", node, {
      description:
        "a private transaction on a group is rejected; on an account it takes the account/private branch (pinned)",
      covalueIds: [group.id, accountID!],
      verdictIds: [group.id, accountID!],
      roleQueries: [],
    });

    hasInvalid(fixture, group.id, "Can't make private transactions in groups");
    await node.gracefulShutdown();
  });

  // =========================================================================
  // Stage-3 scenarios: ownedByGroup / unsafeAllowAll / merged transactions.
  //
  // These verdicts are now produced by the native NodeCore (the kill switch is
  // gone). Their committed fixtures are the frozen golden files captured from
  // the original TypeScript engine (commit b84f15310) — including the
  // reader-branch-pointer trim (validBranchPointerOnly) and the "Transactor has
  // no write permissions" rejections. The native unified validateTransactions
  // must reproduce this verdict CONTENT byte-for-byte on regeneration; see the
  // oracle-inversion note at the top of this file.
  // =========================================================================

  // 19. owned_by_group_roles -----------------------------------------------
  test("owned_by_group_roles", async () => {
    try {
      const { node, group } = newGroupHighLevel();

      const manager = createAccountInNode(node);
      const writer = createAccountInNode(node);
      const writeOnly = createAccountInNode(node);
      const reader = createAccountInNode(node);

      group.addMember(manager, "manager" as any);
      group.addMember(writer, "writer" as any);
      group.addMember(writeOnly, "writeOnly" as any);
      group.addMember(reader, "reader" as any);

      const map = group.createMap();
      // admin (the node's own agent) writes directly → valid
      map.core.makeTransaction(
        [{ op: "set", key: "byAdmin", value: 1 }],
        "trusting",
      );

      // each member writes as themselves (author = their account id)
      const members: [ReturnType<typeof createAccountInNode>, string][] = [
        [manager, "byManager"],
        [writer, "byWriter"],
        [writeOnly, "byWriteOnly"],
        [reader, "byReader"],
      ];
      for (const [acct, key] of members) {
        await actAsOnCoValue(node, map.id, acct, (core) => {
          core.makeTransaction([{ op: "set", key, value: 1 }], "trusting");
        });
      }

      // a non-member (a bare agent never added to the group) writes → invalid
      const nonMember = new ControlledAgent(
        Crypto.newRandomAgentSecret(),
        Crypto,
      );
      await actAsOnCoValue(node, map.id, nonMember, (core) => {
        core.makeTransaction(
          [{ op: "set", key: "byNonMember", value: 1 }],
          "trusting",
        );
      });

      const fixture = exportScenario("owned_by_group_roles", node, {
        description:
          "a comap owned by a group: admin/manager/writer/writeOnly writes are valid; a reader write and a non-member write are both rejected 'Transactor has no write permissions' (agentInAccountOrMemberInGroup never returns undefined, so 'Transactor not found in group' is unreachable)",
        covalueIds: [
          map.id,
          group.id,
          manager.id,
          writer.id,
          writeOnly.id,
          reader.id,
        ],
        verdictIds: [map.id],
        roleQueries: [
          { groupId: group.id, member: manager.id, atTime: null },
          { groupId: group.id, member: writer.id, atTime: null },
          { groupId: group.id, member: writeOnly.id, atTime: null },
          { groupId: group.id, member: reader.id, atTime: null },
          { groupId: group.id, member: nonMember.id, atTime: null },
        ],
        rich: true,
      });

      hasValid(fixture, map.id);
      // reader and non-member both rejected with the write-permission reason
      const invalidReasons = verdictReasons(fixture, map.id).filter(
        (r) => r !== null,
      );
      expect(invalidReasons).toContain("Transactor has no write permissions");
      // exactly two invalid txs (reader + non-member)
      expect(fixture.verdicts[map.id]!.filter((v) => !v.valid).length).toBe(2);
      expect(fixture.roleQueries[0]!.expectedRole).toBe("manager");
      expect(fixture.roleQueries[1]!.expectedRole).toBe("writer");
      expect(fixture.roleQueries[2]!.expectedRole).toBe("writeOnly");
      expect(fixture.roleQueries[3]!.expectedRole).toBe("reader");
      expect(fixture.roleQueries[4]!.expectedRole).toBe(null);
      await node.gracefulShutdown();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // 20. owned_by_group_role_change_over_time -------------------------------
  test("owned_by_group_role_change_over_time", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const { node, group } = newGroupHighLevel();
      const member = createAccountInNode(node);

      vi.setSystemTime(1_700_000_010_000);
      group.addMember(member, "writer" as any);
      const tWriter = Date.now();

      const map = group.createMap();

      // member writes while still a writer → valid at its currentMadeAt
      vi.setSystemTime(1_700_000_020_000);
      await actAsOnCoValue(node, map.id, member, (core) => {
        core.makeTransaction(
          [{ op: "set", key: "early", value: 1 }],
          "trusting",
        );
      });

      // admin demotes the member to reader
      vi.setSystemTime(1_700_000_030_000);
      (group.set as any)(member.id, "reader", "trusting");
      const tReader = Date.now();

      // member writes again, now a reader → invalid at its currentMadeAt
      vi.setSystemTime(1_700_000_040_000);
      await actAsOnCoValue(node, map.id, member, (core) => {
        core.makeTransaction(
          [{ op: "set", key: "late", value: 1 }],
          "trusting",
        );
      });

      const fixture = exportScenario(
        "owned_by_group_role_change_over_time",
        node,
        {
          description:
            "a member is a writer, writes to an owned map (valid), is demoted to reader, then writes again (invalid). ownedByGroup uses each tx's currentMadeAt for the role lookup, so the earlier write stays valid while the later one is rejected.",
          covalueIds: [map.id, group.id, member.id],
          verdictIds: [map.id],
          roleQueries: [
            { groupId: group.id, member: member.id, atTime: tWriter },
            { groupId: group.id, member: member.id, atTime: tReader },
            { groupId: group.id, member: member.id, atTime: null },
          ],
          rich: true,
        },
      );

      // one valid (early), one invalid (late)
      const memberVerdicts = fixture.verdicts[map.id]!.filter((v) =>
        v.sessionId.startsWith(member.id),
      );
      expect(memberVerdicts.some((v) => v.valid)).toBe(true);
      expect(
        memberVerdicts.some(
          (v) => !v.valid && v.reason === "Transactor has no write permissions",
        ),
      ).toBe(true);
      expect(fixture.roleQueries[0]!.expectedRole).toBe("writer");
      expect(fixture.roleQueries[1]!.expectedRole).toBe("reader");
      expect(fixture.roleQueries[2]!.expectedRole).toBe("reader");
      await node.gracefulShutdown();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  // 21. owned_by_account ----------------------------------------------------
  test("owned_by_account", async () => {
    try {
      const { node, accountID } = await LocalNode.withNewlyCreatedAccount({
        peers: [],
        crypto: Crypto,
        creationProps: { name: "OwnerAccount" },
      });

      // a comap owned directly by an ACCOUNT (ownedByGroup.group = accountID).
      const owned = node.createCoValue({
        type: "comap",
        ruleset: { type: "ownedByGroup", group: accountID! },
        meta: null,
        ...Crypto.createdNowUnique(),
      });
      const ownedMap = expectMap(owned.getCurrentContent());
      // the account's own agent authors → agentInAccountOrMemberInGroup resolves
      // the account id to its static header agent, which is admin on the account.
      ownedMap.set("foo", "bar", "trusting");
      ownedMap.set("baz", "qux", "trusting");

      const fixture = exportScenario("owned_by_account", node, {
        description:
          "a comap owned by an ACCOUNT: the account-id transactor is resolved to its agent (agentInAccountOrMemberInGroup account→agent branch on the owned path); the account's self-role is admin so its writes are valid",
        covalueIds: [owned.id, accountID!],
        verdictIds: [owned.id],
        roleQueries: [
          { groupId: accountID!, member: accountID!, atTime: null },
        ],
        rich: true,
      });

      expect(fixture.roleQueries[0]!.expectedRole).toBe("admin");
      hasValid(fixture, owned.id);
      expect(fixture.verdicts[owned.id]!.every((v) => v.valid)).toBe(true);
      await node.gracefulShutdown();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // 22. owned_reader_branch_pointer ----------------------------------------
  test("owned_reader_branch_pointer", async () => {
    try {
      const { node, group } = newGroupHighLevel();
      const reader = createAccountInNode(node);
      group.addMember(reader, "reader" as any);

      // the reader's own group, used as the branch owner.
      const ownerGroup = node.createGroup();

      const map = group.createMap();
      // admin baseline write → valid
      map.core.makeTransaction(
        [{ op: "set", key: "base", value: 1 }],
        "trusting",
      );

      // The reader posts a branch pointer. createBranch (branching.ts:158-181)
      // stores it UNENCRYPTED (trusting) with empty changes and
      // meta {branch, ownerId} precisely so it can be special-cased in the
      // permission check. We craft that exact transaction directly: the public
      // createBranch requires a fully-loaded reader ACCOUNT to pass its local
      // myRole() check, but the clone helper loads the reader as a bare agent,
      // so the raw craft is the faithful equivalent.
      await actAsOnCoValue(node, map.id, reader, (core) => {
        core.makeTransaction([], "trusting", {
          branch: "feature-branch",
          ownerId: ownerGroup.id,
        });
      });

      const fixture = exportScenario("owned_reader_branch_pointer", node, {
        description:
          "a reader posts an unencrypted branch-pointer transaction (meta {branch, ownerId}, empty changes) on a map owned by a group. TS (permissions.ts:124-137) forces meta to {branch, ownerId}, changes to [], and marks it VALID (outcome validBranchPointerOnly) — the reader-branch-pointer trim. The native/Rust ownedByGroup engine does not yet port this and would mark it invalid, so this fixture is captured with the native kill switch forced.",
        covalueIds: [map.id, group.id, reader.id, ownerGroup.id],
        verdictIds: [map.id],
        roleQueries: [{ groupId: group.id, member: reader.id, atTime: null }],
        rich: true,
      });

      const branchPointer = fixture.verdicts[map.id]!.find(
        (v) => v.metaJson != null && v.metaJson.includes("feature-branch"),
      );
      expect(branchPointer).toBeDefined();
      expect(branchPointer!.valid).toBe(true);
      expect(branchPointer!.reason).toBe(null);
      expect(branchPointer!.outcome).toBe("validBranchPointerOnly");
      // the trim leaves meta = exactly {branch, ownerId}
      expect(JSON.parse(branchPointer!.metaJson!)).toEqual({
        branch: "feature-branch",
        ownerId: ownerGroup.id,
      });
      expect(fixture.roleQueries[0]!.expectedRole).toBe("reader");
      await node.gracefulShutdown();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // 23. owned_private_tx_meta_unavailable ----------------------------------
  test("owned_private_tx_meta_unavailable", async () => {
    try {
      const { node, group } = newGroupHighLevel();
      const reader = createAccountInNode(node);
      group.addMember(reader, "reader" as any);

      const ownerGroup = node.createGroup();

      const map = group.createMap();
      map.core.makeTransaction(
        [{ op: "set", key: "base", value: 1 }],
        "trusting",
      );

      // The reader posts the SAME branch-pointer meta, but PRIVATE (encrypted).
      // It is authored in a cloned node and imported, so the master has no
      // parsing cache for it: validation runs BEFORE decryption, so meta is
      // `undefined` at validation, the reader-branch-pointer trim does NOT fire,
      // and the reader (no write permission) is rejected. Contrast scenario 22,
      // where the same author + meta are trusting and therefore trimmed to VALID.
      await actAsOnCoValue(node, map.id, reader, (core) => {
        core.makeTransaction(
          [{ op: "set", key: "secret", value: 1 }],
          "private",
          {
            branch: "feature-branch",
            ownerId: ownerGroup.id,
          },
        );
      });

      const fixture = exportScenario(
        "owned_private_tx_meta_unavailable",
        node,
        {
          description:
            "a received PRIVATE transaction on an owned map validates with meta === undefined (validation precedes decryption — the pipeline-order contract). Even though the reader supplied branch-pointer meta, TS cannot see it at validation, so no trim occurs and the reader write is rejected. metaJson is null (meta unavailable at validation).",
          covalueIds: [map.id, group.id, reader.id],
          verdictIds: [map.id],
          roleQueries: [],
          rich: true,
        },
      );

      const priv = fixture.verdicts[map.id]!.find(
        (v) => v.sessionId.startsWith(reader.id) && !v.valid,
      );
      expect(priv).toBeDefined();
      expect(priv!.reason).toBe("Transactor has no write permissions");
      expect(priv!.outcome).toBe("invalid");
      expect(priv!.metaJson).toBe(null);
      await node.gracefulShutdown();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // 24. unsafe_allow_all ----------------------------------------------------
  test("unsafe_allow_all", async () => {
    try {
      const { node } = newGroupHighLevel();

      const covalue = node.createCoValue({
        type: "comap",
        ruleset: { type: "unsafeAllowAll" },
        meta: null,
        ...Crypto.createdNowUnique(),
      });

      // a well-formed change → valid
      covalue.makeTransaction([{ op: "set", key: "ok", value: 1 }], "trusting");
      // garbage changes (not even valid map ops) → still valid under unsafeAllowAll
      covalue.makeTransaction(
        [{ nonsense: true } as any, "not a change", 42 as any],
        "trusting",
      );
      // arbitrary meta, empty changes → still valid
      covalue.makeTransaction([], "trusting", { arbitrary: "meta" });

      const fixture = exportScenario("unsafe_allow_all", node, {
        description:
          "a covalue with the unsafeAllowAll ruleset: every transaction is marked valid, including garbage changes and arbitrary meta (permissions.ts:176-181).",
        covalueIds: [covalue.id],
        verdictIds: [covalue.id],
        roleQueries: [],
        rich: true,
      });

      expect(fixture.verdicts[covalue.id]!.length).toBe(3);
      expect(fixture.verdicts[covalue.id]!.every((v) => v.valid)).toBe(true);
      expect(
        fixture.verdicts[covalue.id]!.every((v) => v.outcome === "valid"),
      ).toBe(true);
      await node.gracefulShutdown();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // 25. merged_tx_ties ------------------------------------------------------
  test("merged_tx_ties", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const { node, group } = newGroupHighLevel();

      const map = group.createMap();
      map.set("base", "v", "trusting");

      // Create a branch and add TWO transactions at the SAME madeAt, so after a
      // merge they share an effective (source) madeAt and source session and are
      // ordered only by their source txIndex (compareTransactions tie-break:
      // txID = sourceTxID ?? currentTxID).
      const branch = expectMap(
        map.core.createBranch("feature-branch", group.id).getCurrentContent(),
      );

      vi.setSystemTime(1_700_000_010_000);
      branch.set("k1", "a", "trusting");
      branch.set("k2", "b", "trusting"); // same madeAt as k1

      // Merge the branch back into the source map. The merged transactions carry
      // merge meta ({mi, t?, s?, b?}) from which TS recomputes sourceTxMadeAt and
      // sourceTxID during parseMetaInformation.
      vi.setSystemTime(1_700_000_020_000);
      branch.core.mergeBranch();

      const fixture = exportScenario("merged_tx_ties", node, {
        description:
          "a branch with two same-madeAt transactions merged into its owned source map. The merged transactions carry sourceMadeAt + sourceTxId (source identity), and TS compareTransactions tie-breaks equal-madeAt / same-source-session transactions by source txIndex. All transactions are valid (authored by the admin), so verdicts are pinned as a multiset. GAP for the Rust port: a tie where the two transactions share a SOURCE session but land in DIFFERENT CURRENT sessions (so TS orders by source txIndex while a current-(session,txIndex) tie-break would diverge — porter note 9) cannot be produced through the public branch/merge APIs, because a single merge writes every merged transaction into one merger session. This fixture exercises the source-identity computation but not that cross-current-session divergence.",
        covalueIds: [map.id, group.id],
        verdictIds: [map.id],
        roleQueries: [],
        rich: true,
      });

      // every transaction on the source map is valid (multiset)
      expect(fixture.verdicts[map.id]!.every((v) => v.valid)).toBe(true);
      // the admin's own branch pointer is valid via write permissions, NOT the
      // reader trim, so nothing here is validBranchPointerOnly.
      expect(
        fixture.verdicts[map.id]!.some(
          (v) => v.outcome === "validBranchPointerOnly",
        ),
      ).toBe(false);
      // the two merged transactions carry source identity + source madeAt
      const merged = fixture.verdicts[map.id]!.filter(
        (v) => v.sourceTxId !== undefined,
      );
      expect(merged.length).toBe(2);
      expect(merged.every((v) => v.sourceMadeAt !== undefined)).toBe(true);
      // both merged txs share a source session (the branch session) and differ
      // only by source txIndex — the tie-break the Rust port must reproduce.
      expect(merged[0]!.sourceTxId!.sessionID).toBe(
        merged[1]!.sourceTxId!.sessionID,
      );
      expect(merged[0]!.sourceTxId!.txIndex).not.toBe(
        merged[1]!.sourceTxId!.txIndex,
      );
      await node.gracefulShutdown();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
});
