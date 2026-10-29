import { GarbageCollector } from "./GarbageCollector.js";
import { ClockOffset } from "./ClockOffset.js";
import type { CoID } from "./coValue.js";
import type { RawCoValue } from "./coValue.js";
import {
  type AvailableCoValueCore,
  CoValueCore,
  idforHeader,
} from "./coValueCore/coValueCore.js";
import {
  type CoValueHeader,
  type CoValueUniqueness,
} from "./coValueCore/verifiedState.js";
import {
  AccountMeta,
  ControlledAccount,
  ControlledAccountOrAgent,
  ControlledAgent,
  InvalidAccountAgentIDError,
  RawProfile as Profile,
  RawAccount,
  RawAccountID,
  RawAccountMigration,
  RawProfile,
  accountHeaderForInitialAgentSecret,
  expectAccount,
} from "./coValues/account.js";
import {
  type InviteSecret,
  type RawGroup,
  formatGroupSealerValue,
  secretSeedFromInviteSecret,
} from "./coValues/group.js";
import { CO_VALUE_LOADING_CONFIG } from "./config.js";
import { AgentSecret, CryptoProvider, NodeCoreImpl } from "./crypto/crypto.js";
import { AgentID, RawCoID, SessionID, isAgentID, isRawCoID } from "./ids.js";
import { logger } from "./logger.js";
import { StorageAPI } from "./storage/index.js";
import {
  Peer,
  PeerID,
  SyncManager,
  type LocalStoreDurabilityListener,
  type SyncWhen,
} from "./sync.js";
import { accountOrAgentIDfromSessionID } from "./typeUtils/accountOrAgentIDfromSessionID.js";
import { expectGroup } from "./typeUtils/expectGroup.js";
import { canBeBranched } from "./coValueCore/branching.js";
import { connectedPeers } from "./streamUtils.js";
import { CoValueKnownState, emptyKnownState } from "./knownState.js";

/** A `LocalNode` represents a local view of a set of loaded `CoValue`s, from the perspective of a particular account (or primitive cryptographic agent).

A `LocalNode` can have peers that it syncs to, for example some form of local persistence, or a sync server, such as `cloud.jazz.tools` (Jazz Cloud).

@example
You typically get hold of a `LocalNode` using `jazz-react`'s `useJazz()`:

```typescript
const { localNode } = useJazz();
```
*/
export class LocalNode {
  /** @internal */
  crypto: CryptoProvider;
  /** @internal */
  readonly nodeCore: NodeCoreImpl;
  /** @internal */
  private readonly coValues = new Map<RawCoID, CoValueCore>();

  /** @category 3. Low-level */
  readonly currentSessionID: SessionID;
  readonly agentSecret: AgentSecret;

  /** @category 3. Low-level */
  syncManager = new SyncManager(this);

  readonly clockOffset = new ClockOffset();
  #clockSyncEnabled: boolean;

  garbageCollector: GarbageCollector | undefined = undefined;
  crashed: Error | undefined = undefined;

  storage?: StorageAPI;

  /** @category 3. Low-level */
  constructor(
    agentSecret: AgentSecret,
    currentSessionID: SessionID,
    crypto: CryptoProvider,
    public readonly syncWhen?: SyncWhen,
    enableFullStorageReconciliation?: boolean,
    options?: {
      experimental_clockSyncFromServerPings?: boolean;
      onLocalStoreDurabilityChange?: LocalStoreDurabilityListener;
    },
  ) {
    this.agentSecret = agentSecret;
    this.currentSessionID = currentSessionID;
    this.crypto = crypto;
    this.nodeCore = crypto.createNodeCore();
    if (enableFullStorageReconciliation) {
      this.syncManager.fullStorageReconciliationEnabled = true;
    }
    this.#clockSyncEnabled =
      options?.experimental_clockSyncFromServerPings ?? false;
    this.syncManager.onLocalStoreDurabilityChange =
      options?.onLocalStoreDurabilityChange;
  }

  stampNow(): number {
    return this.#clockSyncEnabled
      ? Date.now() + this.clockOffset.currentOffset()
      : Date.now();
  }

  getClockOffsetDiagnostics(): { currentOffset: number; sampleCount: number } {
    return {
      currentOffset: this.clockOffset.currentOffset(),
      sampleCount: this.clockOffset.sampleCount(),
    };
  }

  enableGarbageCollector() {
    if (this.garbageCollector) {
      return;
    }

    this.garbageCollector = new GarbageCollector(this);
  }

  setStorage(storage: StorageAPI) {
    this.storage = storage;
    this.syncManager.setStorage(storage);
  }

  removeStorage() {
    this.storage?.close();
    this.storage = undefined;
    this.syncManager.removeStorage();
  }

  /**
   * Enable background erasure of deleted coValues (space reclamation).
   *
   * Deleted coValues are immediately blocked from syncing via tombstones; this feature
   * only reclaims local storage space by deleting historical content while preserving
   * the tombstone (header + delete session).
   *
   * This is opt-in and affects only the currently configured storage (if any)
   *
   * @category 3. Low-level
   */
  enableDeletedCoValuesErasure() {
    this.storage?.enableDeletedCoValuesErasure();
  }

  hasCoValue(id: RawCoID) {
    const coValue = this.coValues.get(id);

    if (!coValue) {
      return false;
    }

    const state = coValue.loadingState;
    // garbageCollected and onlyKnownState shells don't have actual content loaded
    return (
      state !== "unknown" &&
      state !== "garbageCollected" &&
      state !== "onlyKnownState"
    );
  }

  isCoValueInMemory(id: RawCoID) {
    const state = this.coValues.get(id)?.loadingState;

    return Boolean(state);
  }

  getCoValue(id: RawCoID) {
    let entry = this.coValues.get(id);

    if (!entry) {
      entry = new CoValueCore(id, this);
      this.coValues.set(id, entry);
    }

    this.garbageCollector?.trackCoValueAccess(entry);

    return entry;
  }

  allCoValues() {
    return this.coValues.values();
  }

  /**
   * Simple delete of a CoValue from memory.
   * Used for testing and forced cleanup scenarios.
   * @internal
   */
  internalDeleteCoValue(id: RawCoID) {
    this.coValues.delete(id);
    this.scheduleNodeCoreEviction(id);
    this.storage?.onCoValueUnmounted(id);
  }

  /**
   * Unmount a CoValue from memory, keeping a shell with cached knownState.
   * This enables accurate LOAD requests during peer reconciliation.
   *
   * @returns true if the coValue was successfully unmounted, false otherwise
   */
  internalUnmountCoValue(id: RawCoID): boolean {
    const coValue = this.coValues.get(id);

    if (!coValue) {
      return false;
    }

    if (coValue.listeners.size > 0) {
      // The coValue is still in use
      return false;
    }

    for (const dependant of coValue.dependant) {
      if (this.hasCoValue(dependant)) {
        // Another in-memory coValue depends on this coValue
        return false;
      }
    }

    if (!this.syncManager.isSyncedToServerPeers(id)) {
      return false;
    }

    // Cache the knownState before replacing
    const lastKnownState = coValue.knownState();

    // Handle counter: decrement old coValue's state
    coValue.decrementLoadingStateCounter();

    // Create new shell CoValueCore in garbageCollected state
    const shell = new CoValueCore(id, this);
    shell.setGarbageCollectedState(lastKnownState);

    // Single map update (replacing old with shell)
    this.coValues.set(id, shell);
    this.scheduleNodeCoreEviction(id);

    // Notify storage
    this.storage?.onCoValueUnmounted(id);

    return true;
  }

  /**
   * Drop the NodeCore registry entry for a CoValue that has just been deleted
   * or unmounted.
   *
   * The removal is deferred to the next microtask so that any already-queued
   * {@link LocalTransactionsSyncQueue} batch — which reads the registry to
   * persist and sync local transactions — flushes first (microtasks run in
   * FIFO order). This matters when a CoValue is garbage-collected (or
   * force-deleted) before its last local transaction has been synced: the
   * batch must still be able to read the entry. The guard skips removal when
   * the CoValue has been (re)loaded in the meantime, so a freshly registered
   * entry is never dropped.
   *
   * {@link gracefulShutdown} does NOT evict: a shutting-down node's registry is
   * released wholesale when the node is dropped, and eagerly emptying it while
   * sync messages are still in flight would make in-flight reads throw
   * "Unknown CoValue".
   *
   * @internal
   */
  private scheduleNodeCoreEviction(id: RawCoID) {
    queueMicrotask(() => {
      const current = this.coValues.get(id);
      if (!current || !current.isAvailable()) {
        this.nodeCore.removeCoValue(id);
      }
    });
  }

  getCurrentAccountOrAgentID(): RawAccountID | AgentID {
    return accountOrAgentIDfromSessionID(this.currentSessionID);
  }

  _cachedCurrentAgent: ControlledAccountOrAgent | undefined;
  getCurrentAgent(): ControlledAccountOrAgent {
    if (!this._cachedCurrentAgent) {
      const accountOrAgent = this.getCurrentAccountOrAgentID();
      if (isAgentID(accountOrAgent)) {
        this._cachedCurrentAgent = new ControlledAgent(
          this.agentSecret,
          this.crypto,
        );
      } else {
        this._cachedCurrentAgent = new ControlledAccount(
          expectAccount(
            this.expectCoValueLoaded(accountOrAgent).getCurrentContent(),
          ),
          this.agentSecret,
        );
      }
    }
    return this._cachedCurrentAgent;
  }

  expectCurrentAccountID(reason: string): RawAccountID {
    const accountOrAgent = this.getCurrentAccountOrAgentID();
    if (isAgentID(accountOrAgent)) {
      throw new Error(
        "Current account is an agent, but expected an account: " + reason,
      );
    }
    return accountOrAgent;
  }

  expectCurrentAccount(reason: string): RawAccount {
    const accountID = this.expectCurrentAccountID(reason);
    return expectAccount(
      this.expectCoValueLoaded(accountID).getCurrentContent(),
    );
  }

  static internalCreateAccount(opts: {
    crypto: CryptoProvider;
    initialAgentSecret?: AgentSecret;
    peers?: Peer[];
    syncWhen?: SyncWhen;
    storage?: StorageAPI;
    enableFullStorageReconciliation?: boolean;
    experimental_clockSyncFromServerPings?: boolean;
    onLocalStoreDurabilityChange?: LocalStoreDurabilityListener;
  }): RawAccount {
    const {
      crypto,
      initialAgentSecret = crypto.newRandomAgentSecret(),
      peers = [],
      syncWhen,
    } = opts;
    const accountHeader = accountHeaderForInitialAgentSecret(
      initialAgentSecret,
      crypto,
    );
    const accountID = idforHeader(accountHeader, crypto);

    const node = new LocalNode(
      initialAgentSecret,
      crypto.newRandomSessionID(accountID as RawAccountID),
      crypto,
      syncWhen,
      opts.enableFullStorageReconciliation,
      {
        experimental_clockSyncFromServerPings:
          opts.experimental_clockSyncFromServerPings,
        onLocalStoreDurabilityChange: opts.onLocalStoreDurabilityChange,
      },
    );

    if (opts.storage) {
      node.setStorage(opts.storage);
    }

    for (const peer of peers) {
      node.syncManager.addPeer(peer);
    }

    const accountAgentID = crypto.getAgentID(initialAgentSecret);

    const rawAccount = expectGroup(
      node.createCoValue(accountHeader).getCurrentContent(),
    );

    rawAccount.set(accountAgentID, "admin", "trusting");

    const readKey = crypto.newRandomKeySecret();

    const sealed = crypto.seal({
      message: readKey.secret,
      from: crypto.getAgentSealerSecret(initialAgentSecret),
      to: crypto.getAgentSealerID(accountAgentID),
      nOnceMaterial: {
        in: rawAccount.id,
        tx: rawAccount.core.nextTransactionID(),
      },
    });

    rawAccount.set(`${readKey.id}_for_${accountAgentID}`, sealed, "trusting");

    rawAccount.set("readKey", readKey.id, "trusting");

    return node.expectCurrentAccount("after creation");
  }

  /** @category 2. Node Creation */
  static async withNewlyCreatedAccount({
    creationProps,
    peers,
    syncWhen,
    migration,
    crypto,
    initialAgentSecret = crypto.newRandomAgentSecret(),
    storage,
    enableFullStorageReconciliation,
    experimental_clockSyncFromServerPings,
    onLocalStoreDurabilityChange,
  }: {
    creationProps: { name: string };
    peers?: Peer[];
    syncWhen?: SyncWhen;
    migration?: RawAccountMigration<AccountMeta>;
    crypto: CryptoProvider;
    initialAgentSecret?: AgentSecret;
    storage?: StorageAPI;
    enableFullStorageReconciliation?: boolean;
    experimental_clockSyncFromServerPings?: boolean;
    onLocalStoreDurabilityChange?: LocalStoreDurabilityListener;
  }): Promise<{
    node: LocalNode;
    accountID: RawAccountID;
    accountSecret: AgentSecret;
    sessionID: SessionID;
  }> {
    const account = LocalNode.internalCreateAccount({
      crypto,
      initialAgentSecret,
      peers,
      syncWhen,
      storage,
      enableFullStorageReconciliation,
      experimental_clockSyncFromServerPings,
      onLocalStoreDurabilityChange,
    });
    const node = account.core.node;

    if (migration) {
      await migration(account, node, creationProps);
    } else {
      const profileGroup = node.createGroup();
      profileGroup.addMember("everyone", "reader");
      const profile = profileGroup.createMap<Profile>({
        name: creationProps.name,
      });
      account.set("profile", profile.id, "trusting");
    }

    const profileId = account.get("profile");

    if (!profileId) {
      throw new Error("Must set account profile in initial migration");
    }

    if (node.storage) {
      await Promise.all([
        node.syncManager.waitForStorageSync(account.id),
        node.syncManager.waitForStorageSync(profileId),
      ]);
    }

    return {
      node,
      accountID: account.id,
      accountSecret: initialAgentSecret,
      sessionID: node.currentSessionID,
    };
  }

  /** @category 2. Node Creation */
  static async withLoadedAccount({
    accountID,
    accountSecret,
    sessionID,
    peers,
    syncWhen,
    crypto,
    migration,
    storage,
    enableFullStorageReconciliation,
    experimental_clockSyncFromServerPings,
    onLocalStoreDurabilityChange,
  }: {
    accountID: RawAccountID;
    accountSecret: AgentSecret;
    sessionID: SessionID | undefined;
    peers: Peer[];
    syncWhen?: SyncWhen;
    crypto: CryptoProvider;
    migration?: RawAccountMigration<AccountMeta>;
    storage?: StorageAPI;
    enableFullStorageReconciliation?: boolean;
    experimental_clockSyncFromServerPings?: boolean;
    onLocalStoreDurabilityChange?: LocalStoreDurabilityListener;
  }): Promise<LocalNode> {
    try {
      const expectedAgentID = crypto.getAgentID(accountSecret);

      const node = new LocalNode(
        accountSecret,
        sessionID || crypto.newRandomSessionID(accountID),
        crypto,
        syncWhen,
        enableFullStorageReconciliation,
        {
          experimental_clockSyncFromServerPings,
          onLocalStoreDurabilityChange,
        },
      );

      if (storage) {
        node.setStorage(storage);
      }

      for (const peer of peers) {
        node.syncManager.addPeer(peer);
      }

      const account = await node.load(accountID);

      if (account === "unavailable") {
        throw new Error("Account unavailable from all peers");
      }

      if (account.currentAgentID() !== expectedAgentID) {
        throw new Error(
          "Account secret does not match expected agent ID in account",
        );
      }

      const profileID = account.get("profile");
      if (!profileID) {
        throw new Error("Account has no profile");
      }

      const rootID = account.get("root");
      if (rootID) {
        const rawEntry = account.getRaw("root");

        if (!rawEntry?.trusting) {
          account.set("root", rootID, "trusting");
        }
      }

      // Preload the profile
      await node.load(profileID);

      if (migration) {
        await migration(account, node);
      }

      return node;
    } catch (e) {
      logger.error("Error withLoadedAccount", { err: e });
      throw e;
    }
  }

  /** @internal */
  createCoValue(header: CoValueHeader): AvailableCoValueCore {
    if (this.crashed) {
      throw new Error("Trying to create CoValue after node has crashed", {
        cause: this.crashed,
      });
    }

    const id = idforHeader(header, this.crypto);

    const coValue = this.getCoValue(id);

    coValue.provideHeader(header);

    if (!coValue.hasVerifiedContent()) {
      throw new Error("CoValue not available after providing header");
    }

    this.garbageCollector?.trackCoValueAccess(coValue);
    this.syncManager.syncLocalTransaction(
      coValue.verified,
      emptyKnownState(id),
    );

    return coValue;
  }

  /** @internal */
  async loadCoValueCore(
    id: RawCoID,
    skipLoadingFromPeer?: PeerID,
    skipRetry?: boolean,
  ): Promise<CoValueCore> {
    if (!isRawCoID(id)) {
      throw new TypeError(
        `Trying to load CoValue with invalid id ${Array.isArray(id) ? JSON.stringify(id) : id}`,
      );
    }

    if (this.crashed) {
      throw new Error("Trying to load CoValue after node has crashed", {
        cause: this.crashed,
      });
    }

    let retries = 0;

    while (true) {
      const coValue = this.getCoValue(id);

      if (coValue.isAvailable()) {
        return coValue;
      }

      if (
        coValue.loadingState === "unknown" ||
        coValue.loadingState === "unavailable" ||
        coValue.loadingState === "garbageCollected" ||
        coValue.loadingState === "onlyKnownState"
      ) {
        const peers = this.syncManager.getServerPeers(id, skipLoadingFromPeer);

        if (!this.storage && peers.length === 0) {
          // Flags the coValue as unavailable
          coValue.markNotFoundInPeer("storage");
          return coValue;
        }

        coValue.load(peers);
      }

      const result = await coValue.waitForAvailableOrUnavailable();
      if (
        result.isAvailable() ||
        skipRetry ||
        retries >= CO_VALUE_LOADING_CONFIG.MAX_RETRIES
      ) {
        return result;
      }

      await Promise.race([
        new Promise((resolve) =>
          setTimeout(resolve, CO_VALUE_LOADING_CONFIG.RETRY_DELAY),
        ),
        coValue.waitForAvailable(), // Stop waiting if the coValue becomes available
      ]);

      retries++;
    }
  }

  /**
   * Loads a CoValue's content, syncing from peers as necessary and resolving the returned
   * promise once a first version has been loaded. See `coValue.subscribe()` and `node.useTelepathicData()`
   * for listening to subsequent updates to the CoValue.
   *
   * @category 3. Low-level
   */
  async load<T extends RawCoValue>(
    id: CoID<T>,
    skipRetry?: boolean,
  ): Promise<T | "unavailable"> {
    const core = await this.loadCoValueCore(id, undefined, skipRetry);

    if (!core.isAvailable()) {
      return "unavailable";
    }

    return core.getCurrentContent() as T;
  }

  /**
   * Loads a branch from a group coValue, creating a new one if it doesn't exist.
   *
   * Returns "unavailable" in case of errors or missing source.
   */
  async checkoutBranch<T extends RawCoValue>(
    id: CoID<T> | RawCoID,
    branchName: string,
    branchOwnerID?: RawCoID,
  ): Promise<T | "unavailable"> {
    const source = await this.loadCoValueCore(id);

    if (!source.isAvailable()) {
      return "unavailable";
    }

    if (!canBeBranched(source)) {
      return source.getCurrentContent() as T;
    }

    const branch = source.getBranch(branchName, branchOwnerID);

    if (branch.isAvailable()) {
      return branch.getCurrentContent() as T;
    }

    // Do a synchronous check to see if the branch exists, if not we don't need to try to load the branch
    if (!source.hasBranch(branchName, branchOwnerID)) {
      return source
        .createBranch(branchName, branchOwnerID)
        .getCurrentContent() as T;
    }

    await this.loadCoValueCore(branch.id);

    if (!branch.isAvailable()) {
      return source
        .createBranch(branchName, branchOwnerID)
        .getCurrentContent() as T;
    }

    return branch.getCurrentContent() as T;
  }

  getLoaded<T extends RawCoValue>(id: CoID<T>): T | undefined {
    const coValue = this.getCoValue(id);

    if (coValue.isAvailable()) {
      return coValue.getCurrentContent() as T;
    }

    return undefined;
  }

  /** @category 3. Low-level */
  subscribe<T extends RawCoValue>(
    id: CoID<T>,
    callback: (update: T | "unavailable") => void,
    skipRetry?: boolean,
  ): () => void {
    let stopped = false;
    let unsubscribe!: () => void;

    this.load(id, skipRetry)
      .then((coValue) => {
        if (stopped) {
          return;
        }
        if (coValue === "unavailable") {
          callback("unavailable");
          return;
        }
        unsubscribe = coValue.subscribe(callback);
      })
      .catch((e) => {
        logger.error("Subscription error", {
          id,
          err: e,
        });
      });

    return () => {
      stopped = true;
      unsubscribe?.();
    };
  }

  async acceptInvite<T extends RawCoValue>(
    groupOrOwnedValueID: CoID<T>,
    inviteSecret: InviteSecret,
  ): Promise<void> {
    const value = await this.load(groupOrOwnedValueID);

    if (value === "unavailable") {
      throw new Error(
        "Trying to accept invite: Group/owned value unavailable from all peers",
      );
    }

    const ruleset = value.core.verified.header.ruleset;

    let group: RawGroup;

    if (ruleset.type === "unsafeAllowAll") {
      throw new Error("Can only accept invites to values owned by groups");
    }

    if (ruleset.type === "ownedByGroup") {
      const owner = await this.load(ruleset.group as CoID<RawGroup>);

      if (owner === "unavailable") {
        throw new Error(
          "Trying to accept invite: CoValue owner unavailable from all peers",
        );
      }

      group = expectGroup(owner);
    } else {
      group = expectGroup(value);
    }

    if (group.core.verified.header.meta?.type === "account") {
      throw new Error("Can't accept invites to values owned by accounts");
    }

    const inviteAgentSecret = this.crypto.agentSecretFromSecretSeed(
      secretSeedFromInviteSecret(inviteSecret),
    );

    const inviteAgentID = this.crypto.getAgentID(inviteAgentSecret);

    const inviteRole = await new Promise((resolve, reject) => {
      group.subscribe((groupUpdate) => {
        const role = groupUpdate.get(inviteAgentID);
        if (role) {
          resolve(role);
        }
      });
      setTimeout(
        () => reject(new Error("Couldn't find invite before timeout")),
        2000,
      );
    });

    if (!inviteRole) {
      throw new Error("No invite found");
    }

    const account = this.getCurrentAgent();
    const existingRole = group.get(account.id);

    if (
      existingRole === "admin" ||
      (existingRole === "writer" && inviteRole === "writerInvite") ||
      (existingRole === "writer" && inviteRole === "reader") ||
      (existingRole === "reader" && inviteRole === "readerInvite") ||
      (existingRole && inviteRole === "writeOnlyInvite")
    ) {
      logger.debug("Not accepting invite that would replace or downgrade role");
      return;
    }

    const groupCoreAsDifferentAgent = await this.loadCoValueAsDifferentAgent(
      group.id,
      inviteAgentSecret,
    );

    const groupAsInvite = expectGroup(
      groupCoreAsDifferentAgent.getCurrentContent(),
    );

    groupAsInvite.addMemberInternal(
      account,
      inviteRole === "adminInvite"
        ? "admin"
        : inviteRole === "managerInvite"
          ? "manager"
          : inviteRole === "writerInvite"
            ? "writer"
            : inviteRole === "writeOnlyInvite"
              ? "writeOnly"
              : "reader",
    );

    const contentPieces =
      groupAsInvite.core.newContentSince(group.core.knownState()) ?? [];

    // Import the new transactions to the current localNode
    for (const contentPiece of contentPieces) {
      this.syncManager.handleNewContent(contentPiece, "import");
    }
  }

  /** @internal */
  expectCoValueLoaded(id: RawCoID, expectation?: string): AvailableCoValueCore {
    const coValue = this.getCoValue(id);

    if (!coValue.isAvailable()) {
      throw new Error(
        `${expectation ? expectation + ": " : ""}CoValue ${id} not yet loaded.`,
      );
    }
    return coValue;
  }

  /** @internal */
  expectProfileLoaded(id: RawAccountID, expectation?: string): RawProfile {
    const account = this.expectCoValueLoaded(id, expectation);
    const profileID = expectGroup(account.getCurrentContent()).get("profile");
    if (!profileID) {
      throw new Error(
        `${expectation ? expectation + ": " : ""}Account ${id} has no profile`,
      );
    }
    return this.expectCoValueLoaded(
      profileID,
      expectation,
    ).getCurrentContent() as RawProfile;
  }

  /** @internal */
  resolveAccountAgent(id: RawAccountID | AgentID, expectation?: string) {
    if (isAgentID(id)) {
      return { value: id, error: undefined };
    }

    let coValue: AvailableCoValueCore;

    try {
      coValue = this.expectCoValueLoaded(id, expectation);
    } catch (e) {
      return { value: undefined, error: e };
    }

    if (
      coValue.verified.header.type !== "comap" ||
      coValue.verified.header.ruleset.type !== "group" ||
      !coValue.verified.header.meta ||
      !("type" in coValue.verified.header.meta) ||
      coValue.verified.header.meta.type !== "account"
    ) {
      return {
        value: undefined,
        error: new Error(`Unexpectedly not account: ${expectation}`),
      };
    }

    const agentId = coValue.verified.header.ruleset.initialAdmin;

    if (!isAgentID(agentId)) {
      return {
        value: undefined,
        error: new Error(`Unexpectedly not account: ${expectation}`),
      };
    }

    return { value: agentId, error: undefined };
  }

  createGroup(
    uniqueness: CoValueUniqueness = this.crypto.createdNowUnique(),
    options?: { name?: string },
  ): RawGroup {
    const account = this.getCurrentAgent();

    const meta =
      options?.name != null && options.name !== ""
        ? { name: options.name }
        : null;

    const groupCoValue = this.createCoValue({
      type: "comap",
      ruleset: { type: "group", initialAdmin: account.id },
      meta,
      ...(uniqueness.createdAt !== undefined
        ? { createdAt: uniqueness.createdAt }
        : {}),
      uniqueness: uniqueness.uniqueness,
    });

    const group = expectGroup(groupCoValue.getCurrentContent());

    group.set(account.id, "admin", "trusting");

    const readKey = this.crypto.newRandomKeySecret();

    group.set(
      `${readKey.id}_for_${account.id}`,
      this.crypto.seal({
        message: readKey.secret,
        from: account.currentSealerSecret(),
        to: account.currentSealerID(),
        nOnceMaterial: {
          in: groupCoValue.id,
          tx: groupCoValue.nextTransactionID(),
        },
      }),
      "trusting",
    );

    group.set("readKey", readKey.id, "trusting");

    // Initialize the group sealer (derived deterministically from the read key)
    // Store composite value with readKeyID for deterministic readKey association
    const groupSealer = this.crypto.groupSealerFromReadKey(readKey.secret);
    group.set(
      "groupSealer",
      formatGroupSealerValue(readKey.id, groupSealer.publicKey),
      "trusting",
    );

    return group;
  }

  async loadCoValueAsDifferentAgent(
    id: RawCoID,
    secret: AgentSecret,
    accountId?: RawAccountID | AgentID,
  ) {
    const agent = new ControlledAgent(secret, this.crypto);

    const newNode = new LocalNode(
      secret,
      this.crypto.newRandomSessionID(accountId || agent.id),
      this.crypto,
    );

    await newNode.loadVerifiedStateFrom(this, id);

    return newNode.expectCoValueLoaded(id);
  }

  /** @internal */
  async loadVerifiedStateFrom(otherNode: LocalNode, id: RawCoID) {
    const connection = connectedPeers("source-" + id, "target-" + id, {
      peer1role: "server",
      peer2role: "client",
    });

    this.syncManager.addPeer(connection[0], true);
    otherNode.syncManager.addPeer(connection[1], true);

    const coValue = this.getCoValue(id);

    const peerState = this.syncManager.peers[connection[0].id];

    if (!peerState) {
      throw new Error("Peer state not found");
    }

    coValue.loadFromPeers([peerState]);

    await coValue.waitForAvailable();

    peerState.gracefulShutdown();
  }

  /**
   * Closes all the peer connections, drains all the queues and closes the storage.
   *
   * @returns Promise of the current pending store operation, if any.
   */
  async gracefulShutdown(): Promise<unknown> {
    this.garbageCollector?.stop();
    await this.syncManager.gracefulShutdown();
    // NOTE: NodeCore registry entries are intentionally NOT dropped here.
    // Emptying the shared registry while sync messages are still in flight
    // (e.g. a LOAD queued before shutdown, or one that arrives before the peer
    // is fully torn down) makes a still-available CoValueCore's session reads
    // throw "Unknown CoValue". The whole registry — and every SessionMap it
    // owns (native included) — is released when this node is dropped, so
    // eager removal is unnecessary for reclamation.
    return this.storage?.close();
  }
}

export type LoadCoValueCoreError = {
  type: "ErrorLoadingCoValueCore";
  error: unknown;
  expectation?: string;
  id: RawAccountID;
};

export type AccountUnavailableFromAllPeersError = {
  type: "AccountUnavailableFromAllPeers";
  expectation?: string;
  id: RawAccountID;
};

export type UnexpectedlyNotAccountError = {
  type: "UnexpectedlyNotAccount";
  expectation?: string;
  id: RawAccountID;
};

export type ResolveAccountAgentError =
  | InvalidAccountAgentIDError
  | LoadCoValueCoreError
  | AccountUnavailableFromAllPeersError
  | UnexpectedlyNotAccountError;
