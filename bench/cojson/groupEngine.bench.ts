import cronometro from "cronometro";
import { ControlledAccount, EVERYONE, LocalNode, RawGroup } from "cojson";
import { NapiCrypto } from "cojson/crypto/NapiCrypto";

/**
 * Benchmarks for the native group engine: roleOf on a 3-level parent chain and
 * full re-validation of a 200-transaction group. Both run against
 * NapiCrypto-backed node/group structures and exercise the native NodeCore
 * validation/role-resolution path (all providers now validate natively; napi is
 * used here for a stable local runner).
 */

const Crypto = await NapiCrypto.create();

function freshAccountInNode(node: LocalNode): ControlledAccount {
  const accountOnTempNode = LocalNode.internalCreateAccount({
    crypto: node.crypto,
  });
  const accountCoreEntry = node.getCoValue(accountOnTempNode.id);
  const content = accountOnTempNode.core.newContentSince(undefined)?.[0]!;
  node.syncManager.handleNewContent(content, "import");
  return new ControlledAccount(
    accountCoreEntry.getCurrentContent() as any,
    accountOnTempNode.core.node.agentSecret,
  );
}

function newNode(): LocalNode {
  const agentSecret = Crypto.newRandomAgentSecret();
  const sessionID = Crypto.newRandomSessionID(Crypto.getAgentID(agentSecret));
  return new LocalNode(agentSecret, sessionID, Crypto);
}

// ---------------------------------------------------------------------------
// (a) roleOf on a 3-level parent chain with 20 members, queried 1000x
// ---------------------------------------------------------------------------

const ROLE_CHAIN_MEMBER_COUNT = 20;
const ROLE_QUERY_COUNT = 1000;
const ACCOUNT_ROLES = [
  "reader",
  "writer",
  "manager",
  "admin",
  "writeOnly",
] as const;

interface RoleChainScenario {
  leaf: RawGroup;
  memberIds: string[];
}

function buildRoleChainScenario(): RoleChainScenario {
  const node = newNode();
  const leaf = node.createGroup();
  const mid = node.createGroup();
  const root = node.createGroup();

  leaf.extend(mid);
  mid.extend(root);

  const memberIds: string[] = [];
  for (let i = 0; i < ROLE_CHAIN_MEMBER_COUNT; i++) {
    const member = freshAccountInNode(node);
    memberIds.push(member.id);
    const role = ACCOUNT_ROLES[i % ACCOUNT_ROLES.length]!;

    if (i < 10) {
      // Direct role on the leaf group - no parent walk required.
      (leaf.set as any)(member.id, role, "trusting");
    } else if (i < 15) {
      // Role only on the mid group - one parent hop.
      (mid.set as any)(member.id, role, "trusting");
    } else {
      // Role only on the root group - two parent hops.
      (root.set as any)(member.id, role, "trusting");
    }
  }
  // A couple of everyone-role lookups too, exercised via the roleOf grid below.
  (leaf.set as any)(EVERYONE, "reader", "trusting");

  return { leaf, memberIds };
}

function queryRolesRepeatedly(scenario: RoleChainScenario) {
  for (let i = 0; i < ROLE_QUERY_COUNT; i++) {
    const memberId = scenario.memberIds[i % scenario.memberIds.length]!;
    scenario.leaf.roleOfInternal(memberId as any);
  }
}

// ---------------------------------------------------------------------------
// (b) full validation of a 200-transaction group, forcing a full invalidate +
// re-validate pass each iteration.
// ---------------------------------------------------------------------------

const VALIDATION_TX_COUNT = 200;
const VALIDATION_MEMBER_COUNT = 5;

interface ValidationScenario {
  group: RawGroup;
}

function buildValidationScenario(): ValidationScenario {
  const node = newNode();
  const group = node.createGroup();

  const memberIds: string[] = [];
  for (let i = 0; i < VALIDATION_MEMBER_COUNT; i++) {
    memberIds.push(freshAccountInNode(node).id);
  }

  for (let i = 0; i < VALIDATION_TX_COUNT; i++) {
    const memberId = memberIds[i % memberIds.length]!;
    const role = ACCOUNT_ROLES[i % ACCOUNT_ROLES.length]!;
    (group.set as any)(memberId, role, "trusting");
  }

  return { group };
}

function revalidateFully(scenario: ValidationScenario) {
  // resetParsedTransactions() marks every verified transaction as
  // to-validate again and re-runs parseNewTransactions over the whole
  // (200-transaction) history. The Rust engine's (session_id, tx_count) cache
  // SHORT-CIRCUITS (no new transactions), so this number is the end-to-end
  // DELEGATION-PATH cost — pending[] build, napi crossing, marshaling ~200
  // verdicts back, byKey map + verdict application — NOT Rust compute time.
  scenario.group.core.resetParsedTransactions();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let roleChainScenario: RoleChainScenario;
let validationScenario: ValidationScenario;

const benchOptions = {
  iterations: 50,
  warmup: true,
  print: {
    colors: true,
    compare: true,
  },
  onTestError: (testName: string, error: unknown) => {
    console.error(`\nError in test "${testName}":`);
    console.error(error);
  },
};

await cronometro(
  {
    "roleOf - 3-level parent chain, 20 members x1000 (native)": {
      async before() {
        roleChainScenario = buildRoleChainScenario();
      },
      test() {
        queryRolesRepeatedly(roleChainScenario);
      },
    },
    "validateTransactions - 200-tx group, full revalidate (native)": {
      async before() {
        validationScenario = buildValidationScenario();
      },
      test() {
        revalidateFully(validationScenario);
      },
    },
  },
  benchOptions,
);
