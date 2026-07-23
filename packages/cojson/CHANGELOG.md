# cojson

## 0.20.20

### Patch Changes

- cojson-core-wasm@0.20.20
- cojson-core-rn@0.20.20
- cojson-core-napi@0.20.20

## 0.20.19

### Patch Changes

- dc43d1d: Recover from partially-written storage rows in async SQLite storage. Interrupted write transactions could leave orphan `transactions`/`signatureAfter` rows that made every subsequent store of the same session fail with "UNIQUE constraint failed: transactions.ses, transactions.idx"; those rows are now overwritten instead.
- b13e956: Prevent unrecoverable session forking when a client crashes after transactions
  were sent to the sync server but before they were persisted locally. Sessions
  are now flagged while such a window is open, and the browser and React Native
  session providers mint a fresh session instead of reusing a flagged one.
  - cojson-core-wasm@0.20.19
  - cojson-core-rn@0.20.19
  - cojson-core-napi@0.20.19

## 0.20.18

### Patch Changes

- 12b27e1: Add opt-in experimental clock synchronisation from server pings.
  - cojson-core-wasm@0.20.18
  - cojson-core-rn@0.20.18
  - cojson-core-napi@0.20.18

## 0.20.17

### Patch Changes

- cojson-core-wasm@0.20.17
- cojson-core-rn@0.20.17
- cojson-core-napi@0.20.17

## 0.20.16

### Patch Changes

- 8b40b3a: Fix InvalidSignature errors when loading from storage with a concurrent writer

  The storage load path read session metadata and transaction rows in separate
  non-transactional queries. The transaction query used `idx <= lastIdx` where
  `lastIdx` is a count, not an index. When a concurrent writer committed a new
  transaction at that index between the two reads, the query picked up the extra
  row and paired it with a signature that didn't cover it.

  Convert `lastIdx` to an index (`lastIdx - 1`) so the query matches the
  convention used by `signatureAfter` entries. This ensures a stale session read
  never overshoots the signature boundary, even under concurrent writes.

- f45aca2: Add cursor-based time travel for CoValues

  Introduces the ability to create cursors (frontier snapshots) on loaded CoValues and later reload them at that exact point in time. Cursors encode the full frontier state of a CoValue and its resolved children, enabling read-only historical views.
  - Add `createCursor()` and `cursor` getter to CoValue instances
  - Support loading CoValues by cursor via `load()` and `ensureLoaded()`
  - Add `useCurrentCursor` option to capture the current state as a cursor
  - Prevent mutations on cursor-loaded (time-travel) CoValues
  - Validate cursor root ID and resolve query compatibility (subset check)
  - cojson-core-wasm@0.20.16
  - cojson-core-rn@0.20.16
  - cojson-core-napi@0.20.16

## 0.20.15

### Patch Changes

- 7446c56: Add an incoming queue metric that measures sync message processing time by
  `messageType`.
- Updated dependencies [2d5cb0b]
  - cojson-core-wasm@0.20.15
  - cojson-core-rn@0.20.15
  - cojson-core-napi@0.20.15

## 0.20.14

### Patch Changes

- 4bbfce2: Avoid recursive WASM aliasing errors when checking streaming state, including the `newContentSince()` path.
  - cojson-core-wasm@0.20.14
  - cojson-core-rn@0.20.14
  - cojson-core-napi@0.20.14

## 0.20.13

### Patch Changes

- 9877c61: Add a new incoming queue metric that tracks pushed sync messages by type (`messageType`).
  - cojson-core-wasm@0.20.13
  - cojson-core-rn@0.20.13
  - cojson-core-napi@0.20.13

## 0.20.12

### Patch Changes

- Updated dependencies [debcb49]
  - cojson-core-rn@0.20.12
  - cojson-core-wasm@0.20.12
  - cojson-core-napi@0.20.12

## 0.20.11

### Patch Changes

- d91408c: Wait for coValue sync before acknowledging a storage reconciliation batch
  - cojson-core-wasm@0.20.11
  - cojson-core-rn@0.20.11
  - cojson-core-napi@0.20.11

## 0.20.10

### Patch Changes

- 706ab57: Added optional restricted deletion mode for CoList values, allowing only manager/admin roles to perform deletions when enabled via schema permissions: `co.list().withPermission({writer: "appendOnly"})`
- 3f50adb: Throw immediately when calling `.create()` on a group where the current user does not have write permissions, instead of silently producing empty data.
- 283ff4f: Fixed an issue where CoValues could remain stuck in a loading state when using persistent server peers.

  Closed persistent peers are now marked unavailable after a grace timeout, and load requests are no longer considered complete when a peer replies with `KNOWN` and `header: true` but never sends content.

- 93c220c: Improved sync load handling and queue behavior by prioritizing pending loads and ensuring peers always respond to load requests, including cases with no new content.

  Added queue and in-flight load metrics, plus richer WebSocket peer metadata and ping-delay logging to improve observability during sync operations.

- 41d8587: Run a full storage reconciliation process periodically to ensure all CoValues in storage are synced with the server.
- Updated dependencies [706ab57]
  - cojson-core-wasm@0.20.10
  - cojson-core-rn@0.20.10
  - cojson-core-napi@0.20.10

## 0.20.9

### Patch Changes

- cojson-core-wasm@0.20.9
- cojson-core-rn@0.20.9
- cojson-core-napi@0.20.9

## 0.20.8

### Patch Changes

- c7be307: Improved FileStream base64 encoding performance by using `bytesToBase64url` instead of `btoa` with `String.fromCharCode`. Added native `toBase64`/`fromBase64` support in cojson when available.

  **Benchmark results (5MB file):**
  - `asBase64`: 732.39 op/sec vs 49.78 op/sec (**+1371.36% faster**)
  - `write`: 12.53 op/sec vs 12.19 op/sec (+2.79%)
  - `getChunks`: 695.03 op/sec vs 153.89 op/sec (**+351.64% faster**)

- b38a526: fix: prevent conflicts between concurrent async SQLite transactions
- f701fd7: Added optional `name` metadata to Groups. Groups can now be created with a display name (e.g. `Group.create({ owner: account, name: "Engineering" })`)
- 99f9d47: Improved performance of writeKey revelations validation in groups with many writeOnlyKeys
  - cojson-core-wasm@0.20.8
  - cojson-core-rn@0.20.8
  - cojson-core-napi@0.20.8

## 0.20.7

### Patch Changes

- 988941c: Fixed a bug in `BatchedOutgoingMessages.push()` where messages sent via the fast path (when WebSocket is ready and not backpressured) were added to the queue but never removed. This caused the `pushed - pulled` metric to grow indefinitely even when the system was idle.

  The fix moves the `queue.push()` call to only happen when taking the slow path (when WebSocket is not ready), since the fast path sends messages directly without using the queue.
  - cojson-core-wasm@0.20.7
  - cojson-core-rn@0.20.7
  - cojson-core-napi@0.20.7

## 0.20.6

### Patch Changes

- cdf8274: Improve performance of read key lookups in groups by using cached indices instead of iterating through all keys
  - cojson-core-wasm@0.20.6
  - cojson-core-rn@0.20.6
  - cojson-core-napi@0.20.6

## 0.20.5

### Patch Changes

- cojson-core-wasm@0.20.5
- cojson-core-rn@0.20.5
- cojson-core-napi@0.20.5

## 0.20.4

### Patch Changes

- cojson-core-wasm@0.20.4
- cojson-core-rn@0.20.4
- cojson-core-napi@0.20.4

## 0.20.3

### Patch Changes

- eca8b83: Added caching for groups when accessing a readKey.
  Marked private transactions in groups as invalid.
  - cojson-core-wasm@0.20.3
  - cojson-core-rn@0.20.3
  - cojson-core-napi@0.20.3

## 0.20.2

### Patch Changes

- 251a89e: Optimized peer reconciliation to prevent unnecessary data transfer on reconnect.
  - cojson-core-wasm@0.20.2
  - cojson-core-rn@0.20.2
  - cojson-core-napi@0.20.2

## 0.20.1

### Patch Changes

- 03195eb: Added client-side load request throttling to improve the loading experience when loading a lot of data concurrently.

  When a client requests more than 1k CoValues concurrently, load requests are now queued locally and sent as capacity becomes available.
  - cojson-core-wasm@0.20.1
  - cojson-core-rn@0.20.1
  - cojson-core-napi@0.20.1

## 0.20.0

### Minor Changes

- f562a1f: Restricted the `Uniqueness` type to only accept specific values instead of any `JsonValue`.
  The allowed types are now: `string`, `number` (as integers), `boolean`, `null`, `undefined`,
  or an object with string values. Arrays, non-integer numbers, and objects with non-string values are no longer
  accepted and will throw an error.

  Deprecated `number`, even if it is an integer, as it is not a valid uniqueness type in TS, if you want to continue using numbers,
  use a string instead or ignore the type check.

- b5ada4d: breaking change: now removeMember throws if unauthorized
- 8934d8a: ## Full native crypto (0.20.0)

  With this release we complete the migration to a pure Rust toolchain and remove the JavaScript crypto compatibility layer. The native Rust core now runs everywhere: React Native, Edge runtimes, all server-side environments, and the web.

  ## 💥 Breaking changes

  ### Crypto providers / fallback behavior
  - **Removed `PureJSCrypto`** from `cojson` (including the `cojson/crypto/PureJSCrypto` export).
  - **Removed `RNQuickCrypto`** from `jazz-tools`.
  - **No more fallback to JavaScript crypto**: if crypto fails to initialize, Jazz now throws an error instead of falling back silently.
  - **React Native + Expo**: **`RNCrypto` (via `cojson-core-rn`) is now the default**.

  Full migration guide: `https://jazz.tools/docs/upgrade/0-20-0`

### Patch Changes

- 6b9368a: Added `deleteCoValues` function to permanently delete CoValues and their nested references.
  - CoValues are marked with a tombstone, making them inaccessible to all users
  - Supports deleting nested CoValues via resolve queries
  - Requires admin permissions on the CoValue's group
  - Introduces new `deleted` loading state for deleted CoValues
  - Groups and Accounts are skipped during deletion

  See documentation: https://jazz.tools/docs/react/core-concepts/deleting

- 89332d5: Moved stable JSON serialization from JavaScript to Rust in SessionLog operations

  ### Changes
  - **`tryAdd`**: Stable serialization now happens in Rust. The Rust layer parses each transaction and re-serializes it to ensure a stable JSON representation for signature verification. JavaScript side now uses `JSON.stringify` instead of `stableStringify`.

  - **`addNewPrivateTransaction`** and **`addNewTrustingTransaction`**: Removed `stableStringify` usage since the data is either encrypted (private) or already in string format (trusting), making stable serialization unnecessary on the JS side.

- Updated dependencies [89332d5]
- Updated dependencies [8934d8a]
  - cojson-core-wasm@0.20.0
  - cojson-core-napi@0.20.0
  - cojson-core-rn@0.20.0

## 0.19.22

### Patch Changes

- 3b70482: Wait for CoValues' dependencies to be garbage-collected before collecting them. This makes accounts and groups safe to be collected.
- 6078ea5: Wait for CoValues to be synced before garbage-collecting them
  - cojson-core-wasm@0.19.22
  - cojson-core-rn@0.19.22
  - cojson-core-napi@0.19.22

## 0.19.19

### Patch Changes

- 83f84ca: Resume interrupted CoValue sync on app restart (without requiring CoValues to be manually reloaded)
  - cojson-core-wasm@0.19.19
  - cojson-core-rn@0.19.19
  - cojson-core-napi@0.19.19

## 0.19.18

### Patch Changes

- cojson-core-wasm@0.19.18
- cojson-core-rn@0.19.18
- cojson-core-napi@0.19.18

## 0.19.17

### Patch Changes

- cojson-core-wasm@0.19.17
- cojson-core-rn@0.19.17
- cojson-core-napi@0.19.17

## 0.19.16

### Patch Changes

- 265d0e9: Improved sync timeout error messages to include known state, peer state, and any error information when waiting for sync times out
  - cojson-core-wasm@0.19.16
  - cojson-core-rn@0.19.16
  - cojson-core-napi@0.19.16

## 0.19.15

### Patch Changes

- 71ed9d6: Fixed an issue where spreading the uniqueness object when creating CoValues could introduce unexpected properties into the header
  - cojson-core-wasm@0.19.15
  - cojson-core-rn@0.19.15
  - cojson-core-napi@0.19.15

## 0.19.14

### Patch Changes

- Updated dependencies [41d4c52]
- Updated dependencies [241123b]
  - cojson-core-rn@0.19.14
  - cojson-core-napi@0.19.14
  - cojson-core-wasm@0.19.14

## 0.19.13

### Patch Changes

- cojson-core-wasm@0.19.13
- cojson-core-rn@0.19.13
- cojson-core-napi@0.19.13

## 0.19.12

### Patch Changes

- cojson-core-wasm@0.19.12
- cojson-core-rn@0.19.12
- cojson-core-napi@0.19.12

## 0.19.11

### Patch Changes

- c00a454: Resolve footgun in Account.createAs() that made it easy to save the wrong credentials.
  - cojson-core-wasm@0.19.11
  - cojson-core-rn@0.19.11
  - cojson-core-napi@0.19.11

## 0.19.10

### Patch Changes

- Updated dependencies [4f5a5e7]
  - cojson-core-rn@0.19.10
  - cojson-core-wasm@0.19.10
  - cojson-core-napi@0.19.10

## 0.19.9

### Patch Changes

- d901caa: Added cojson-core-rn that improves ReactNative crypto performance
- Updated dependencies [d901caa]
  - cojson-core-rn@0.1.1
  - cojson-core-wasm@0.19.9
  - cojson-core-napi@0.19.9

## 0.19.8

### Patch Changes

- 93e4a34: Improved the transaction revalidation system to consider parent groups and rebuild only when the validity of the transactions changes
  - cojson-core-wasm@0.19.8
  - cojson-core-napi@0.19.8

## 0.19.7

### Patch Changes

- cojson-core-wasm@0.19.7
- cojson-core-napi@0.19.7

## 0.19.6

### Patch Changes

- cojson-core-wasm@0.19.6
- cojson-core-napi@0.19.6

## 0.19.5

### Patch Changes

- 343c2e4: Improve the permission checks performance by optimizing the parent groups retrival
  - cojson-core-wasm@0.19.5
  - cojson-core-napi@0.19.5

## 0.19.4

### Patch Changes

- cojson-core-wasm@0.19.4
- cojson-core-napi@0.19.4

## 0.19.3

### Patch Changes

- cojson-core-wasm@0.19.3
- cojson-core-napi@0.19.3

## 0.19.2

### Patch Changes

- 7e76313: Prevent CoValues adding themselves as dependencies
  - cojson-core-wasm@0.19.2
  - cojson-core-napi@0.19.2

## 0.19.1

### Patch Changes

- afd2ded: Reuse the same instance of the raw coValue view on invalidation from permissions
  - cojson-core-wasm@0.19.1
  - cojson-core-napi@0.19.1

## 0.19.0

### Patch Changes

- cojson-core-wasm@0.19.0
- cojson-core-napi@0.19.0

## 0.18.38

### Patch Changes

- 349ca48: chore: improve error logging for invalid transactions
- 68781a0: Disable client-to-client streaming state propagation
  - cojson-core-wasm@0.18.38
  - cojson-core-napi@0.18.38

## 0.18.37

### Patch Changes

- 0e923d1: Fixed permission verification in groups when members are revoked
- fd89225: Export PeerState
  - cojson-core-wasm@0.18.37
  - cojson-core-napi@0.18.37

## 0.18.36

### Patch Changes

- af3fe4c: Disable the background child key rotation for groups
  - cojson-core-wasm@0.18.36
  - cojson-core-napi@0.18.36

## 0.18.35

### Patch Changes

- d47ac6d: Remove neverthrow to easily propagate the original stacktrace of the transaction errors
  - cojson-core-wasm@0.18.35
  - cojson-core-napi@0.18.35

## 0.18.34

### Patch Changes

- 4a79953: Fixed streaming status checks when handling streaming updates
- d7e5cc8: Aligned the chunking algorithm of the local transactions sync with the one used for the general sync
  - cojson-core-wasm@0.18.34
  - cojson-core-napi@0.18.34

## 0.18.33

### Patch Changes

- 5ffe0a9: - Wait for the full download of all the dependency graph before running the migrations
  - Re-enable the progressive child key rotation
  - cojson-core-wasm@0.18.33
  - cojson-core-napi@0.18.33

## 0.18.32

### Patch Changes

- 8f47a9e: Switch to the native decrypt when decrypting transactions with RNQuickCrypto
  - cojson-core-wasm@0.18.32
  - cojson-core-napi@0.18.32

## 0.18.31

### Patch Changes

- 7c2b7b8: Bugfix: diable the progressive child rotation
  - cojson-core-wasm@0.18.31
  - cojson-core-napi@0.18.31

## 0.18.30

### Patch Changes

- ad83da2: Optimize the parsing of large CoValues by switching to stages containers
- d08b7e2: feat: introduced new "manager" role who can invite and remove members, and being removed by admins.
  - cojson-core-wasm@0.18.30
  - cojson-core-napi@0.18.30

## 0.18.29

### Patch Changes

- cojson-core-wasm@0.18.29
- cojson-core-napi@0.18.29

## 0.18.28

### Patch Changes

- e8880dc: Fix write permissions checks on merged transactions by checking membership on merge time instead of original transaction time
- d83b5e3: Allow the creation of branch pointers to accounts with reader access
- 5320349: Fix concurrent loading from storage
  - cojson-core-wasm@0.18.28
  - cojson-core-napi@0.18.28

## 0.18.27

### Patch Changes

- cojson-core-wasm@0.18.27
- cojson-core-napi@0.18.27

## 0.18.26

### Patch Changes

- f956cd3: Fix validation for self-revocation in groups. Now self-revocation will be considered as valid also by other accounts.
  - cojson-core-wasm@0.18.26
  - cojson-core-napi@0.18.26

## 0.18.25

### Patch Changes

- 4036737: "peersToLoadFrom" renamed to only "peers"
  - cojson-core-wasm@0.18.25
  - cojson-core-napi@0.18.25

## 0.18.24

### Patch Changes

- b09785e: fix: reveal child groups' writeOnly keys to parent groups
  - cojson-core-wasm@0.18.24
  - cojson-core-napi@0.18.24

## 0.18.23

### Patch Changes

- cojson-core-wasm@0.18.23
- cojson-core-napi@0.18.23

## 0.18.22

### Patch Changes

- 1e20db6: Added cojson-core-napi
- Updated dependencies [1e20db6]
  - cojson-core-napi@0.18.22
  - cojson-core-wasm@0.18.22

## 0.18.21

### Patch Changes

- cojson-core-wasm@0.18.21

## 0.18.20

### Patch Changes

- e75b3d6: Stop new content processing until all the dependencies are available, preventing inconsistent statuses on sync.

  This targets a bug that would show up only after we roll out the sync server sharding features.

- ecf4967: Add garbageCollectGroups option to enableGarbageCollector
- d0e2210: Batch subscribe updates during the applyDiff execution
  - cojson-core-wasm@0.18.20

## 0.18.19

### Patch Changes

- cojson-core-wasm@0.18.19

## 0.18.18

### Patch Changes

- ed7e353: Add batching on per-coValue updates when the update doesn't come from a local change
  - cojson-core-wasm@0.18.18

## 0.18.17

### Patch Changes

- 925da72: Fix unavailable state emitted when a load operation falls back from storage to network
  - cojson-core-wasm@0.18.17

## 0.18.16

### Patch Changes

- Updated dependencies [629c275]
  - cojson-core-wasm@0.18.16

## 0.18.15

### Patch Changes

- a584ab3: Add WasmCrypto support for Cloudflare Workers and edge runtimes by importing `jazz-tools/load-edge-wasm`.
  - Enable WasmCrypto functionality by initializing the WebAssembly environment with the import: `import "jazz-tools/load-edge-wasm"` in edge runtimes.
  - Guarantee compatibility across Cloudflare Workers and other edge runtime environments.

- Updated dependencies [a584ab3]
  - cojson-core-wasm@0.18.15

## 0.18.14

### Patch Changes

- cojson-core-wasm@0.18.14

## 0.18.13

### Patch Changes

- 48837f2: Validate incoming id/header to ensure that the id matches the header hash
- 2ddf4d9: Introducing version control APIs, unstable_branch and unstable_merge

  Flagged as unstable because branch & merge scope & propagation needs to be validated.
  - cojson-core-wasm@0.18.13

## 0.18.12

### Patch Changes

- cojson-core-wasm@0.18.12

## 0.18.11

### Patch Changes

- a4a9a1e: Fix CoPlainText applyDiff chunking to ensure we fit in the TRANSACTION_CONFIG.MAX_RECOMMENDED_TX_SIZE for each transaction
  - cojson-core-wasm@0.18.11

## 0.18.10

### Patch Changes

- cojson-core-wasm@0.18.10

## 0.18.9

### Patch Changes

- f058875: Add removePeer() method to SyncManager
  - cojson-core-wasm@0.18.9

## 0.18.8

### Patch Changes

- 9a4caf2: Ability for SyncManager to ignore unknown covalues arriving from server peers
  - cojson-core-wasm@0.18.8

## 0.18.7

### Patch Changes

- c2d8bf7: Avoid greedily sending covalue dependencies to server peers
- dccb464: Optimize seal and unseal in PureJSCrypto by caching the shared key generation
- a3cd9c8: Add lastUpdatedAt & createdAt properties to $jazz in all the coValue types
- e8e7bf8: Enforce a 1MB size limit for transactions
- 51d3558: Export the highest weighted random server peer selector
  - cojson-core-wasm@0.18.7

## 0.18.6

### Patch Changes

- 9e792c7: Fixed the merge operation for RawCoList and RawCoPlainText and done a small performance optimization on RawCoList
  - cojson-core-wasm@0.18.6

## 0.18.5

### Patch Changes

- cojson-core-wasm@0.18.5

## 0.18.4

### Patch Changes

- Updated dependencies [e5283c2]
  - cojson-core-wasm@0.18.4

## 0.18.3

### Patch Changes

- cojson-core-wasm@0.18.3

## 0.18.2

### Patch Changes

- 82ba2dd: Add basic branching system for single CoValues with createBranch, checkoutBranch, and mergeBranch
- 01f4889: Fix self-revoke check to correctly validate against the author of the change
  - cojson-core-wasm@0.18.2

## 0.18.1

### Patch Changes

- cojson-core-wasm@0.18.1

## 0.18.0

### Minor Changes

- f263856: Add `$jazz` field to CoValues:
  - This field contains Jazz methods that cluttered CoValues' API, as well as Jazz internal properties. This field is not enumerable, to allow CoValues to behave similarly to JSON objects.
  - Added a `$jazz.set` method to update a CoValue's fields. When updating collaborative fields, you can pass in JSON objects instead of CoValues and Jazz will create
    the CoValues automatically (similarly to CoValue `create` methods).
  - All CoMap methods have been moved into `$jazz`, to allow defining any arbitrary key in the CoMap (except for `$jazz`) without conflicts.
    - For CoMaps created with `co.map`, fields are now `readonly` to prevent setting properties directly. Use the `$jazz.set` method instead.
    - CoMaps created with class schemas don't get type errors on direct property assignments, but they get a runtime errors prompting indicating to use `$jazz.set`.
    - the `delete` operator can no longer be used to delete CoRecord properties. Use `$jazz.delete` instead.
  - CoList's array-mutation methods have been moved into `$jazz`, in order to prevent using methods
    - CoLists are now readonly arrays. Trying to use any mutation method yields a type error.
    - `$jazz.set` can be used in place of direct element assignments.
    - Added two new utility methods: `$jazz.remove` and `$jazz.retain`. They allow editing a CoList in-place with a simpler API than `$jazz.splice`.
    - `sort`, `reverse`, `fill` and `copyWithin` have been deprecated, given that they could behave inconsistently with CoLists. `$jazz` replacements may be introduced
      in future releases.
  - `.$jazz.owner` now always returns a Group (instead of a Group or an Account). We'll be migrating away of having Accounts as CoValue owners in future releases.
  - Removed `castAs`, since it's an inherently unsafe operation that bypassed typechecking and enabled using CoValues in unsupported ways.
  - Removed the `id` and `_type` fields from `toJSON()`'s output in Account, CoMap, CoFeed & FileStream, to make CoValues behave more similarly to JSON objects.
  - Removed the `root` and `profile` fields from Group.

### Patch Changes

- b709494: Allow adding server peers without reconciliation
  - cojson-core-wasm@0.18.0

## 0.17.14

### Patch Changes

- 1094b7c: Prevent adding and removing members from Account owners.
- 6378ad5: Expose a server peer selector that implements the Highest Weighted Random algorithm.
  - cojson-core-wasm@0.17.14

## 0.17.13

### Patch Changes

- 7dc3160: Apply `serverPeerSelector` in all the peers getters
- 474881d: Add support for meta field in transactions and ignore all unkonwn meta when getting valid transactions
  - cojson-core-wasm@0.17.13

## 0.17.12

### Patch Changes

- c2daf3e: Don't greedily send dependencies to servers in "known" replies
- 72a63bf: Ability to filter getServerPeers() result based on covalue id
- 234bf91: Correctly wait for updated CoValues when handling HTTP requests on server workers before sending the response
  - cojson-core-wasm@0.17.12

## 0.17.11

### Patch Changes

- 68b2f37: Only request covalue dependencies when transaction verification is enabled
- 257ded3: Fix admin permission downgrade to writeOnly
  - Allow admin to self-downgrade to writeOnly
  - Prevent admin from downgrading other admins to writeOnly
- e301ad6: Skip agent resolution when skipVerify is true
  - cojson-core-wasm@0.17.11

## 0.17.10

### Patch Changes

- c55297c: Move the session log management into WASM
  - cojson-core-wasm@0.17.10

## 0.17.9

### Patch Changes

- 7586c3b: Adds disableTransactionVerification() method to SyncManager

## 0.17.8

## 0.17.7

## 0.17.6

## 0.17.5

### Patch Changes

- 71c1411: Removed some unnecessary content messages sent after a local transaction when sending a value as dependency before the ack response
- 2d11d44: Make the CoValueCore.unmount function detach the CoValue from LocalNode

## 0.17.4

## 0.17.3

### Patch Changes

- f0c73d9: Allow storing empty content with header in handleNewContent

## 0.17.2

### Patch Changes

- 5b2b16a: Filter invalid sessions when storing a content message

## 0.17.1

### Patch Changes

- 2fd88b9: Add debug info to sync correction errors

## 0.17.0

## 0.16.6

### Patch Changes

- 67e0968: Fix content streaming chunking, now chunks should be splitted always respecting the MAX_RECOMMENDED_TX_SIZE
- ce9ca54: Chunk CoPlainText content to avoid generating bg messages when the user past a megabytes of text
- 4b99ff1: Add a multi-storage scheduler to avoid conflicting store operations when having multiple storage instances open on the same database
- ac5d20d: Add ingress and egress metering
- 9bf7946: Added a TTL based optional garbage collection for covalues

## 0.16.5

### Patch Changes

- 3cd1586: Makes the key rotation not fail when child groups are unavailable or their readkey is not accessible.

  Also changes the Group.removeMember method to not return a Promise, because:
  - All the locally available child groups are rotated immediately
  - All the remote child groups are rotated in background, but since they are not locally available the user won't need the new key immediately

- 267f689: Groups: fix the readkey not being revealed to everyone when doing a key rotation

## 0.16.4

### Patch Changes

- f9d538f: Fix the error raised when extending a group without having child groups loaded
- 802b5a3: Refactor local updates sync to ensure that the changes are synced respecting the insertion order

## 0.16.3

## 0.16.2

## 0.16.1

## 0.16.0

### Minor Changes

- c09dcdf: Change the root attribute to be public on Account. The root content will still follow the visiblity rules specified in their group.

  Existing accounts will be gradually migrated as they are loaded.

## 0.15.16

## 0.15.15

## 0.15.14

### Patch Changes

- 70ce7c5: Introduce the persistent peers. Used to mark the WebSocket connections to the server as persistent, and wait for reconnection before failing load.

## 0.15.13

## 0.15.12

## 0.15.11

## 0.15.10

## 0.15.9

### Patch Changes

- 27b4837: Wait for the full streaming before return values in load and subscribe
- 2776263: - Refactored the Peer incoming/outgoing channels to be syncronous
  - Changed the storage communication to work with an explicit API and removed the storage role on peers
  - Added scheduling of the incoming messages using a round-robin over the peers and a timer to do collaborative scheduling with the event loop
  - Added expectContentUntil on the content messages to optimize content syncing with servers during streaming

## 0.15.8

## 0.15.7

## 0.15.6

## 0.15.5

## 0.15.4

### Patch Changes

- 277e4d4: Fix sync with circular deps

## 0.15.3

## 0.15.2

### Patch Changes

- 4b964ed: Add debug code on transactions parsing

## 0.15.1

### Patch Changes

- b110f00: Added `CoMap.upsertUnique` & `CoMap.loadUnique` methods (deprecating `CoMap.findUnique`) and added `skipRetry` option to `CoMap.load`

## 0.15.0

## 0.14.28

## 0.14.27

## 0.14.26

### Patch Changes

- e74a077: Improve the missing dependencies recovery & management

## 0.14.25

## 0.14.24

## 0.14.23

### Patch Changes

- 1ca9299: Adds grapheme split helpers for coText

## 0.14.22

### Patch Changes

- 57fb69f: fix: clarify `Group.addMember` error message when attempting to set roles with insufficient permissions

## 0.14.21

### Patch Changes

- c3d8779: Fix setting latestTxMadeAt when the transaction is empty. (can happen when calling assign with an empty object)

## 0.14.20

## 0.14.19

## 0.14.18

### Patch Changes

- 0d5ee3e: Enable react-native-quick-crypto xsalsa20 accelerated algorithm for encrypt/decrypt functions

## 0.14.16

### Patch Changes

- 5e253cc: Version bump

## 0.14.15

### Patch Changes

- 23daa7c: Align the processing of the group dependencies between LocalNode and Storage.

## 0.14.1

### Patch Changes

- c8b33ad: Force sync of the group after acceptInvite

## 0.14.0

### Minor Changes

- 5835ed1: Type-level changes to support Zod schemas in jazz-tools

## 0.13.31

### Patch Changes

- d63716a: Fix removing members when the admin doesn't have access to the parent group readkeys
- d5edad7: Group invites: restore support for role upgrades and inviting revoked members

## 0.13.30

### Patch Changes

- 07dd2c5: Restore the longer timeout for the storage loading

## 0.13.29

### Patch Changes

- eef1a5d: Load: increase the coValue retry delay and stop waiting as soon as the value becomes available
- 191ae38: Upgrade @noble/ciphers to 1.3.0, @noble/curves to 1.9.1 and @noble/hashes to 1.8.0
- daee7b9: Correctly rotate the readKey when downgrading a member to writeOnly

## 0.13.28

### Patch Changes

- e7ccb2c: Recover missing dependencies when getting new content

## 0.13.27

### Patch Changes

- 6357052: Allow accounts to self-remove from groups

## 0.13.25

### Patch Changes

- a846e07: Block load of invalid ids on a lower level and do not break sync when getting invalid ids

## 0.13.23

### Patch Changes

- 6b781cf: Add getBinaryStreamInfo to RawBinaryCoStreamView to make it possible to retrieve file info without processing all the chunks

## 0.13.21

### Patch Changes

- e14e61f: Optimized the acceptInvite flow

## 0.13.20

### Patch Changes

- adfc9a6: Make waitForSync work on storage peers by handling optimistic/known states
- 1389207: Removed throw error when the profile is unavailable after a login
- d6e143e: Wait for storage sync before resolving new account creation
- 3e6229d: Skip closed and unsubscribed peers when calling waitForSync

## 0.13.18

### Patch Changes

- 9089252: Optimized and simplified LocalNode account creation flow
- b470f63: Optimize the sync protocol to reduce the amount of messages exchanged during the applications bootstrap
- 66373ba: Fix an error when trying to call sendNewContentIncludingDependencies without all the dependencies loaded
- f24cad1: Skip self-sync on storage peers when getting new content

## 0.13.17

### Patch Changes

- 9fb98e2: Resolve CoValue load as soon as the core is available
- 0b89fad: Re-introduce incremental processing on RawCoList

## 0.13.16

### Patch Changes

- c6fb8dc: Handle null values in msg.id

## 0.13.15

### Patch Changes

- c712ef2: Revert the RawCoList incremental processing

## 0.13.14

### Patch Changes

- 5c2c7d4: Make the incoming messages handling in the sync manager syncronous

## 0.13.13

### Patch Changes

- ec9cb40: Remove .every() call on iterator to fix compat issues with React Native

## 0.13.12

### Patch Changes

- 65719f2: Simplified CoValue loading state management

## 0.13.11

### Patch Changes

- 17273a6: Adds locale support to Segmenter for CoPlainText
  Adds insertAfter to CoPlainText
- 3396ed4: Simplify unknown value management on handleNewContent
- 267ea4c: Fix max recursion error happening on large colists

## 0.13.10

### Patch Changes

- f837cfe: Fix fatal errors happening when loading a CoValueCore without having the dependencies

## 0.13.7

### Patch Changes

- bc3d7bb: Allow to assign the writeOnly role to everyone
- 4e9aae1: Remove risky awaits from handleSyncMessage code path
- 21c935c: Improved the management of peer reconnection and optimized the sync messages
- aa1c80e: feat: add transactions size histogram & loaded covalues gauges
- 13074be: Skip loading from closed peers as early as possible

## 0.13.5

### Patch Changes

- e090b39: Bump crypto version to remove WASM init warning

## 0.13.2

### Patch Changes

- c551839: Add jazz.messagequeue.pushed/pulled counters, remove jazz.messagequeue.size gauge

## 0.13.0

### Minor Changes

- bce3bcc: Version bump. Release focused on React Native.

### Patch Changes

- a013538: Correctly load CoValues after they are marked as unavailable and improve timeout management

## 0.12.2

### Patch Changes

- c2f4827: StreamingHash: Remove redundant clone and skip double hash generation when creating a local transaction

## 0.12.1

### Patch Changes

- 5a00fe0: Re-introducing linked lists on PriorityBasedMessageQueue

## 0.12.0

### Minor Changes

- 01523dc: Check CoValue access permissions when loading
- 01523dc: Return the EVERYONE role if the account is not direct a member of the group

## 0.11.8

### Patch Changes

- 6c86c4f: Fix "Expected header to be sent in first message error" on sync
- 9d0c9dc: Update @opentelemetry/api dependency

## 0.11.7

### Patch Changes

- 2b94bc8: Performance: optimize Group.roleOf getter and made the transactions validation incremental for CoMap and CoFeed
- 2957362: Throw an error when the user tries to load an invalid or undefined id

## 0.11.6

### Patch Changes

- 8ed144e: Fix transaction sorting when the timestamps are equal

## 0.11.5

### Patch Changes

- 60f5b3f: Downgrade the WasmCrypto initialization error logging to a warning

## 0.11.4

### Patch Changes

- 7f036c1: Use PureJSCrypto as fallback when WasmCrypto fails to initialize

## 0.11.3

### Patch Changes

- 68b0242: Improve the error logging to have more information on errors leveraging the pino err serializer

## 0.11.0

### Minor Changes

- e22de9f: Fix roleOf resolution for "everyone"
- 34cbdc3: Added revokeExtend method to Group

### Patch Changes

- b9d194a: Added getAllMemberKeysSet method on RawGroup
  Add everyone to the possible inputs of Group.roleOf
- a4713df: Moving to the d.ts files for the exported type definitions
- 0f67e0a: Allow optional fields in types passed to coField.json

## 0.10.15

### Patch Changes

- f86e278: Downgrade the permissions error logs to debug

## 0.10.8

### Patch Changes

- 153dc99: Catch errors on CoValueCore subscribers to avoid effects on the sync

## 0.10.7

### Patch Changes

- 0f83320: Use jazz-crypto-rs isomorphic bundle
- 012022d: Improve error logging on sync errors

## 0.10.6

### Patch Changes

- 5c76e37: Ports Wasm crypto functions to use exported library `jazz-crypto-rs`

## 0.10.4

### Patch Changes

- 1af6072: Revert PriorityBasedMessageQueue to use an array-based queue

## 0.10.2

### Patch Changes

- cae3a9e: Add debug info to load failure end missing header errors

## 0.10.1

### Patch Changes

- 5a63cba: Crypto packages must now be imported from cojson/crypto/WasmCrypto or cojson/crypto/PureJSCrypto
  Removed the separated dists for React Native.

## 0.10.0

### Minor Changes

- 498954f: Introducing the new auth system!

### Patch Changes

- b426342: Export the coValue loading config to reduce the timeout on tests
- 8217981: Drop node 14 polyfill for globalThis.crypto
- ac3d9fa: Reduce the retries on coValue not found to two
- 610543c: Add role mapping to Group.extend

## 0.9.23

### Patch Changes

- 70c9a5d: Rotate keys before revoking access, so when admins remove themselves the keys are successfully rotated

## 0.9.19

### Patch Changes

- 6ad0a9f: Export Json types

## 0.9.18

### Patch Changes

- 8898b10: Export AccountRole type

## 0.9.13

### Patch Changes

- 8d29e50: Restore the logger wrapper and adapt the API to pino

## 0.9.12

### Patch Changes

- 15d4b2a: Revert the custom logger

## 0.9.11

### Patch Changes

- efbf3d8: Optimize queue management
- 5863bad: Wrap all the console logs with a logger class to make possible to customize the logger

## 0.9.10

### Patch Changes

- 4aa377d: Handle unkown coValue content type and optimize content access

## 0.9.9

### Patch Changes

- 8eb9247: Add CoPlainText and CoRichText covalues

## 0.9.0

### Patch Changes

- 8eda792: Add a crypto entry to optionally import the crypto modules
- 1ef3226: Add the assign method to RawCoMap to create bulk transactions and optimize RawCoMap init

## 0.8.50

### Patch Changes

- 43378ef: Handle circular references in group inheritance

## 0.8.49

### Patch Changes

- 25dfd90: Fixes the transactions collection on permissions to avoid RangeError issues

## 0.8.48

### Patch Changes

- 10ea733: Give the ability to extend a group to accounts with reader, writer and writeOnly access level to the parent group and not only admins. The account still needs to be an admin on the child group to be able to extend it.

## 0.8.45

### Patch Changes

- 6f0bd7f: Throw an error if an invite is created from an account owned coValue
- fca6a0b: skip verify step when creating a new local transaction
- 88d7d9a: Add Inbox a new experimental API to simplfy the initial handshake between accounts

## 0.8.44

### Patch Changes

- 5d20c81: Add an internal API to disable the permission errors logs

## 0.8.41

### Patch Changes

- 3252502: Optimize the transactions processing on CoMap and CoStream
- 6370348: Remove @opentelemetry/api as a peer dependency and add it as a dependency
- ac216b9: Add a new writeOnly role, to limit access only to their own changes. Useful to push objects into lists of moderated content.

## 0.8.39

### Patch Changes

- 249eecb: Added new APIs to wait for CoValue sync
- 3121551: Add connected peers gauge metric

## 0.8.38

### Patch Changes

- b00ee91: Apply time travel when checking the roles on a parent group
- f488c09: Add message queue size metrics

## 0.8.37

### Patch Changes

- 3d9f12e: Optimize the atTime processing on CoMap

## 0.8.36

### Patch Changes

- 441fe27: Optimise large record-like CoMaps for access of latest value

## 0.8.35

### Patch Changes

- 3f15a23: Resolve deadlock in cluster setup with multiple layers of sync & storage servers
- 46f2ab8: Add emptyKnownState and SessionNewContent to the package exports
- 8b87117: Implement Group Inheritance
- a6b6ccf: Upload new coValues when a peer is added

## 0.8.34

### Patch Changes

- e4f110f: Removed a no more valid error on the known state message sync

## 0.8.32

### Patch Changes

- df42b2b: Catch hard-to-debug errors when trying to get edits at a CoMap key called "constructor"

## 0.8.31

### Patch Changes

- e511d6d: Performance: make the isUploaded check on the SyncStateManager lazy

## 0.8.30

### Patch Changes

- 0a2fae3: More optimised way to get knownState
- 99cda2f: Reduce noise on peer close and increase the load timeout

## 0.8.29

### Patch Changes

- dcc9c2e: Clear out the queues when closing a Peer
- 699553f: Restore offline support and improve loading perfromance when values are cached

## 0.8.28

### Patch Changes

- 605734c: Send empty known state on all states except available

## 0.8.27

### Patch Changes

- 75fdff4: Improve the initial load by telling what's on storage in the first load request

## 0.8.23

### Patch Changes

- 6f745be: Retry unavailable coValues and improve the state management around them
- 124bf67: Add a flag to delete a peer when it is closed

## 0.8.21

### Patch Changes

- 0f30eea: Improved the known state tracking within the PeerState.knownState property

## 0.8.19

### Patch Changes

- 9c2aadb: Set a CoValue as errored per peer after first error

## 0.8.18

### Patch Changes

- d4319d8: Immediately ack new content before syncing it upstream

## 0.8.17

### Patch Changes

- d433cf4: Add a new API to wait for a CoValue to be uploaded in a peer

## 0.8.16

### Patch Changes

- b934fab: Temp fix for more graceful handling of accidental multiple agents in account

## 0.8.12

### Patch Changes

- 6ed75eb: Introduce "storage" peer role

## 0.8.11

### Patch Changes

- 1ed4ab5: Make the peer known states subscribable

## 0.8.5

### Patch Changes

- c3f4e6b: Fix order of exports fields in package.json
- d9152ed: Allow interface types as generic argument in coField.json

## 0.8.3

### Patch Changes

- Experimental support for React Native

## 0.8.0

### Patch Changes

- 6a147c2: Move session generation to crypto provider
- ad40b88: First sketch of API for creating and finding unique CoValues

## 0.7.35

### Patch Changes

- 35bbcd9: Clean up binary stream ending logic
- f350e90: Added a priority system for the sync messages

## 0.7.34

### Patch Changes

- 5d91f9f: Stop using tryAddTransactionsAsync
- 5094e6d: Start introducing neverthrow, make tryAddNewTransactionsAsync and handleNewContent less throwy
- b09589b: Only one async transaction per CoValue at a time again
- 2c3a40c: Use fork of queueable
- 4e16575: Use queueable fork
- ea882ab: Better log message for failed transactions

## 0.7.34-neverthrow.8

### Patch Changes

- Use queueable fork

## 0.7.34-neverthrow.7

### Patch Changes

- Use fork of queueable

## 0.7.34-neverthrow.4

### Patch Changes

- Stop using tryAddTransactionsAsync

## 0.7.34-neverthrow.3

### Patch Changes

- Better log message for failed transactions

## 0.7.34-neverthrow.1

### Patch Changes

- Only one async transaction per CoValue at a time again

## 0.7.34-neverthrow.0

### Patch Changes

- Start introducing neverthrow, make tryAddNewTransactionsAsync and handleNewContent less throwy

## 0.7.33

### Patch Changes

- b297c93: Improve logging
- 3bf5127: Allow crashing whole node on peer errors
- a8b74ff: Throw properly on peer that should crash on close

## 0.7.33-hotfixes.5

### Patch Changes

- Make simulated errors even more likely

## 0.7.33-hotfixes.4

### Patch Changes

- Throw properly on peer that should crash on close

## 0.7.33-hotfixes.3

### Patch Changes

- Allow crashing whole node on peer errors

## 0.7.33-hotfixes.0

### Patch Changes

- Improve logging

## 0.7.31

### Patch Changes

- Close both ends of the peer on gracefulShutdown

## 0.7.29

### Patch Changes

- Remove noisy log

## 0.7.28

### Patch Changes

- Fix ignoring server peers

## 0.7.26

### Patch Changes

- Remove Effect from jazz/cojson internals

## 0.7.23

### Patch Changes

- Mostly complete OPFS implementation (single-tab only)

## 0.7.18

### Patch Changes

- Update to Effect 3.5.2

## 0.7.17

### Patch Changes

- Fix bugs in new storage interface

## 0.7.14

### Patch Changes

- Use Effect Queues and Streams instead of custom queue implementation

## 0.7.11

### Patch Changes

- Fix webpack import of node:crypto module

## 0.7.10

### Patch Changes

- Also cache agent ID in RawControlledAccount

## 0.7.9

### Patch Changes

- Cache currentAgentID in RawAccount

## 0.7.0

### Minor Changes

- e299c3e: New simplified API

### Patch Changes

- 1a35307: WIP working-ish version of LSM storage
- 96c494f: Implement profile visibility based on groups & new migration signature
- 19f52b7: Fixed bug with newRandomSessionID being called before crypto was ready
- d8fe2b1: Expose experimental OPFS storage
- 1200aae: CoJSON performance improvement
- 52675c9: Fix CoList.splice / RawCoList.append
- 1a35307: Optimizations for incoming sync messages
- bf0f8ec: Fix noble curves dependency
- c4151fc: Support stricter TS lint rules
- 8636319: Factor out implementation of crypto provider and provide pure JS implementation
- 952982e: Consistent proxy based API
- 21771c4: Reintroduce changes from main
- 69ac514: Use effect schema much less
- f0f6f1b: Clean up API more & re-add jazz-nodejs
- 1a44f87: Refactoring
- 63374cc: Make sure delete on CoMaps deletes keys

## 0.7.0-alpha.42

### Patch Changes

- Fixed bug with newRandomSessionID being called before crypto was ready

## 0.7.0-alpha.39

### Patch Changes

- Fix noble curves dependency

## 0.7.0-alpha.38

### Patch Changes

- Factor out implementation of crypto provider and provide pure JS implementation

## 0.7.0-alpha.37

### Patch Changes

- Expose experimental OPFS storage

## 0.7.0-alpha.36

### Patch Changes

- 1a35307: WIP working-ish version of LSM storage
- 1a35307: Optimizations for incoming sync messages

## 0.7.0-alpha.35

### Patch Changes

- CoJSON performance improvement

## 0.7.0-alpha.29

### Patch Changes

- Reintroduce changes from main

## 0.7.0-alpha.28

### Patch Changes

- Implement profile visibility based on groups & new migration signature

## 0.7.0-alpha.27

### Patch Changes

- Fix CoList.splice / RawCoList.append

## 0.7.0-alpha.24

### Patch Changes

- Make sure delete on CoMaps deletes keys

## 0.7.0-alpha.11

### Patch Changes

- Support stricter TS lint rules

## 0.7.0-alpha.10

### Patch Changes

- Clean up API more & re-add jazz-nodejs

## 0.7.0-alpha.7

### Patch Changes

- Consistent proxy based API

## 0.7.0-alpha.5

### Patch Changes

- Refactoring

## 0.7.0-alpha.1

### Patch Changes

- Use effect schema much less

## 0.7.0-alpha.0

### Minor Changes

- New simplified API

## 0.6.6

### Patch Changes

- Fix migration changes being lost on loaded account

## 0.6.5

### Patch Changes

- Fix loading of accounts

## 0.6.4

### Patch Changes

- IndexedDB & timer perf improvements

## 0.6.3

### Patch Changes

- Implement passphrase based auth

## 0.6.2

### Patch Changes

- Add peersToLoadFrom for node creation as well

## 0.6.1

### Patch Changes

- Provide localNode to AccountMigrations

## 0.6.0

### Minor Changes

- Make addMember and removeMember take loaded Accounts instead of just IDs

## 0.5.2

### Patch Changes

- Allow account migrations to be async

## 0.5.1

### Patch Changes

- Fix bug where accounts, profiles and data created in migrations isn't synced on account creation

## 0.5.0

### Minor Changes

- Adding a lot of performance improvements to cojson, add a stresstest for the twit example and make that run smoother in a lot of ways.
