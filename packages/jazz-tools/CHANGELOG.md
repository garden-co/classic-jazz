# jazz-tools

## 0.20.20

### Patch Changes

- ea0ca5c: Preserve active browser sessions whose transactions have not yet been persisted instead of reclaiming their session slots.
- 9385ad4: Keep Better Auth client plugin callback types host-defined and expose only stable Jazz schema metadata for server-plugin inference.
  - cojson@0.20.20
  - cojson-storage-indexeddb@0.20.20
  - cojson-transport-ws@0.20.20

## 0.20.19

### Patch Changes

- b13e956: Prevent unrecoverable session forking when a client crashes after transactions
  were sent to the sync server but before they were persisted locally. Sessions
  are now flagged while such a window is open, and the browser and React Native
  session providers mint a fresh session instead of reusing a flagged one.
- dc43d1d: Serialize Expo SQLite transactions at the connection level. The adapter is shared across providers/contexts, so concurrent storage clients could nest `BEGIN` statements on the same connection, causing "cannot start a transaction within a transaction" and "cannot rollback - no transaction is active" errors during storage reconciliation.
- Updated dependencies [dc43d1d]
- Updated dependencies [b13e956]
  - cojson@0.20.19
  - cojson-storage-indexeddb@0.20.19
  - cojson-transport-ws@0.20.19

## 0.20.18

### Patch Changes

- ab2e90b: Fix a Better Auth race condition where a slow `/get-session` request returning `null` after a successful sign-in would incorrectly log the user out. The client plugin now tracks an `authGeneration` counter, attaches it to `/get-session` requests via an `x-jazz-auth-generation` header, and ignores stale null responses whose generation no longer matches the current one.
- 12b27e1: Add opt-in experimental clock synchronisation from server pings.
- 1c6e9ff: Fix circularity issues when using CoMap `extend()` or `safeExtend()`
- ab2e90b: Fix `createJazzContext` hanging when an account migration loads a `co.discriminatedUnion()` CoValue whose stored value matches no declared variant. The runtime discriminator now throws a dedicated `SchemaUnionNoMatchingVariantError` that `SubscriptionScope` catches and surfaces as `UNAVAILABLE`, so `load()` settles instead of hanging. Other instantiation errors (e.g. `CoVector` dimension mismatches) still throw loudly.
- Updated dependencies [12b27e1]
  - cojson@0.20.18
  - cojson-transport-ws@0.20.18
  - cojson-storage-indexeddb@0.20.18

## 0.20.17

### Patch Changes

- d26dccc: Fix MCP docs server failing to use SQLite/FTS5 backend by preventing bundlers from stripping the `node:` prefix on `node:sqlite` imports.
- 6572f1f: Add new co.snapshotRef() CoValue that abstracts away cursor-based snapshotting and allows snapshots of values to be seamlessly referenced
- 754df86: Accept an options object `{ baseURL, valueHint? }` as the third argument to `createInviteLink`, matching the signature already used by the browser and React Native wrappers. The positional form `(value, role, baseURL, valueHint?)` is deprecated but still supported.
  - cojson@0.20.17
  - cojson-storage-indexeddb@0.20.17
  - cojson-transport-ws@0.20.17

## 0.20.16

### Patch Changes

- f45aca2: Add cursor-based time travel for CoValues

  Introduces the ability to create cursors (frontier snapshots) on loaded CoValues and later reload them at that exact point in time. Cursors encode the full frontier state of a CoValue and its resolved children, enabling read-only historical views.
  - Add `createCursor()` and `cursor` getter to CoValue instances
  - Support loading CoValues by cursor via `load()` and `ensureLoaded()`
  - Add `useCurrentCursor` option to capture the current state as a cursor
  - Prevent mutations on cursor-loaded (time-travel) CoValues
  - Validate cursor root ID and resolve query compatibility (subset check)

- Updated dependencies [8b40b3a]
- Updated dependencies [f45aca2]
  - cojson@0.20.16
  - cojson-storage-indexeddb@0.20.16
  - cojson-transport-ws@0.20.16

## 0.20.15

### Patch Changes

- 05b28a9: Fix race condition in `AuthSecretStorage.set()` where `isAuthenticated` was set to `true` before the KV store write completed, causing spurious logouts in the BetterAuth client.
- 53bd0c4: Correctly handle `z.partialRecord` to allow optional enum keys
- 109afa7: Introduce `omit`, `extend`, and `safeExtend` methods to CoMap schemas
- Updated dependencies [7446c56]
  - cojson@0.20.15
  - cojson-storage-indexeddb@0.20.15
  - cojson-transport-ws@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies [4bbfce2]
  - cojson@0.20.14
  - cojson-storage-indexeddb@0.20.14
  - cojson-transport-ws@0.20.14

## 0.20.13

### Patch Changes

- 307b11d: fix(better-auth): import createAuthMiddleware from better-auth/api for compatibility with better-auth 1.5.3
- 1acba7b: Add MCP docs server exposing Jazz documentation as searchable tools for AI assistants, accessible via `jazz-run mcp`.
- 53c2cc2: Updated `jazz-tools/tiptap` to align `JazzSyncExtension` with the Tiptap 3 plugin interface and allow `coRichText` to be initialized later before syncing starts.
- Updated dependencies [9877c61]
  - cojson@0.20.13
  - cojson-storage-indexeddb@0.20.13
  - cojson-transport-ws@0.20.13

## 0.20.12

### Patch Changes

- 9a43096: Fixed Better Auth email OTP sign-in to handle email addresses case-insensitively.
  - cojson@0.20.12
  - cojson-storage-indexeddb@0.20.12
  - cojson-transport-ws@0.20.12

## 0.20.11

### Patch Changes

- 191ce7a: Mark CoValue migration failures as unavailable instead of throwing behavior.

  When a migration throws (for example, async migrations or write attempts without permissions), loading now resolves to a CoValue with `$jazz.loadingState === "unavailable"`.

- Updated dependencies [d91408c]
  - cojson@0.20.11
  - cojson-storage-indexeddb@0.20.11
  - cojson-transport-ws@0.20.11

## 0.20.10

### Patch Changes

- 706ab57: Added optional restricted deletion mode for CoList values, allowing only manager/admin roles to perform deletions when enabled via schema permissions: `co.list().withPermission({writer: "appendOnly"})`
- 01c3641: Add optional `navigation` prop to `JazzSvelteProvider` that automatically waits for pending CoValue syncs before SvelteKit navigations, preventing stale data on SSR pages.
- 796c65b: **BREAKING:** The `in` operator on CoMap instances now returns `true` for all schema-defined keys, even if the value is `undefined` or has been deleted. This fixes a fatal `TypeError` on React Native 0.84+ (Hermes V1) caused by proxy invariant violations.

  Previously, `"key" in coMap` returned `false` for unset/deleted optional properties. Now it returns `true` for any key with a schema descriptor, consistent with `Object.keys()` and `Object.getOwnPropertyDescriptor()`.

  To check whether a key has an actual value set, use `coMap.$jazz.has("key")` instead of the `in` operator.

  Also adds `configurable: true` to all internal property definitions (`$jazz`, `$isLoaded`, `[TypeSym]`, `_instanceID`) across all CoValue types to satisfy ES2015 proxy invariants enforced by Hermes V1.

- 81c3a0a: Replaced a vulnerable dependency with a local implementation, removing transitive vulnerabilities.
- cdcdad1: Introduced runtime validation for schema-based CoValues. All mutations now accept a `validation` option of `strict` or `loose`. `setDefaultValidationMode()` can also be used to enable or disable validation across the entire app. Currently, the default validation mode is `warn`: updates and inserts of invalid data will still be allowed, but a console warning will be issued. The usage of `setDefaultValidationMode("strict")` is encouraged, as it will be the default mode in the future.
- 1317e90: Removed the legacy `coField` and `Encoders` exports and completed the runtime schema migration to the new schema descriptors. Apps still using the old schema APIs should migrate to the current `co`/zod based schemas.
- 76c6229: Reuse Expo & OP-SQLite DB client across Jazz providers
- e707d3c: Add contextual hints to the "unable to load" error message when sync is disabled (`when: "never"`) or restricted (`when: "signedUp"`).
- Updated dependencies [706ab57]
- Updated dependencies [3f50adb]
- Updated dependencies [283ff4f]
- Updated dependencies [93c220c]
- Updated dependencies [41d8587]
  - cojson@0.20.10
  - cojson-transport-ws@0.20.10
  - cojson-storage-indexeddb@0.20.10

## 0.20.9

### Patch Changes

- 75ecd19: Reverted the Expo SQLite adapter to use non-exclusive transactions, to fix the "database is locked" error when read queries are executed in the middle of a transaction.
  - cojson@0.20.9
  - cojson-storage-indexeddb@0.20.9
  - cojson-transport-ws@0.20.9

## 0.20.8

### Patch Changes

- 8688239: Add `getOrCreateUnique` method to CoMap, CoList, and CoFeed

  This new method provides a "get or create only" semantic - it returns an existing value as-is, and only uses the provided value when creating a new CoValue. Unlike `upsertUnique`, it does NOT update existing values with the provided value.

  Example usage:

  ```typescript
  const billingStatus = await BillingStatus.getOrCreateUnique({
    value: { status: "pending" },
    unique: `billing-${user.$jazz.id}`,
    owner: billingGroup,
  });
  ```

  Also deprecates `loadUnique` and `upsertUnique` methods in favor of `getOrCreateUnique`.

- fc4163a: Delayed CoValue content parsing in subscriptions until the value is fully downloaded, avoiding unnecessary intermediate parsing
- c7be307: Improved FileStream base64 encoding performance by using `bytesToBase64url` instead of `btoa` with `String.fromCharCode`. Added native `toBase64`/`fromBase64` support in cojson when available.

  **Benchmark results (5MB file):**
  - `asBase64`: 732.39 op/sec vs 49.78 op/sec (**+1371.36% faster**)
  - `write`: 12.53 op/sec vs 12.19 op/sec (+2.79%)
  - `getChunks`: 695.03 op/sec vs 153.89 op/sec (**+351.64% faster**)

- 739ea48: Fixed createdAt getter to use CoValue's header
- b38a526: fix: prevent conflicts between concurrent async SQLite transactions
- f701fd7: Added optional `name` metadata to Groups. Groups can now be created with a display name (e.g. `Group.create({ owner: account, name: "Engineering" })`)
- 0fa9e15: Fix issue with CoRecord serialisation
- Updated dependencies [c7be307]
- Updated dependencies [b38a526]
- Updated dependencies [f701fd7]
- Updated dependencies [99f9d47]
  - cojson@0.20.8
  - cojson-storage-indexeddb@0.20.8
  - cojson-transport-ws@0.20.8

## 0.20.7

### Patch Changes

- Updated dependencies [988941c]
  - cojson@0.20.7
  - cojson-transport-ws@0.20.7
  - cojson-storage-indexeddb@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [cdf8274]
  - cojson@0.20.6
  - cojson-storage-indexeddb@0.20.6
  - cojson-transport-ws@0.20.6

## 0.20.5

### Patch Changes

- 23a5d7c: Fixed "TypeError: crypto.randomUUID is not a function (it is undefined)" on React Native
- 0b95532: Fixed "can't access property useContext, dispatcher is null" error when using the inspector in Svelte
  - cojson@0.20.5
  - cojson-storage-indexeddb@0.20.5
  - cojson-transport-ws@0.20.5

## 0.20.4

### Patch Changes

- 0c749d9: Fixed infinite re-render loop when accessing unresolved nested CoValues in React hooks
  - cojson@0.20.4
  - cojson-storage-indexeddb@0.20.4
  - cojson-transport-ws@0.20.4

## 0.20.3

### Patch Changes

- Updated dependencies [eca8b83]
  - cojson@0.20.3
  - cojson-storage-indexeddb@0.20.3
  - cojson-transport-ws@0.20.3

## 0.20.2

### Patch Changes

- 2df568f: Added a Performance tab in the Jazz tools inspector
- Updated dependencies [251a89e]
  - cojson@0.20.2
  - cojson-storage-indexeddb@0.20.2
  - cojson-transport-ws@0.20.2

## 0.20.1

### Patch Changes

- ca306c0: Fixed `CoList` to return the correct length when calling `getOwnPropertyDescriptor` with `length`. Previously it was always returning 0.
- d7f9cba: `setDefaultSchemaPermissions` now modifies existing CoValue schemas
- Updated dependencies [03195eb]
  - cojson@0.20.1
  - cojson-storage-indexeddb@0.20.1
  - cojson-transport-ws@0.20.1

## 0.20.0

### Minor Changes

- ee19292: Removed `JazzContextManagerContext` and added error when nesting `JazzProvider` components. This prevents bad patterns like nested providers and simplifies the alternative approach of using `JazzContext.Provider` directly with `useJazzContext()`.

  ### Breaking changes
  - Removed `JazzContextManagerContext` export from `jazz-tools/react-core`
  - Renamed `useJazzContext` to `useJazzContextValue` (returns the context value)
  - `useJazzContext` now returns the context manager instead of the context value
  - Nesting `JazzProvider` components now throws an error

  ### Migration

  If you were using `useJazzContext` to get the context value, rename it to `useJazzContextValue`:

  ```diff
  - import { useJazzContext } from "jazz-tools/react-core";
  + import { useJazzContextValue } from "jazz-tools/react-core";

  - const context = useJazzContext();
  + const context = useJazzContextValue();
  ```

  If you need to provide context to children without creating a new context (e.g., for components that don't propagate React context), use:

  ```tsx
  <JazzContext.Provider value={useJazzContext()}>
    {children}
  </JazzContext.Provider>
  ```

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

- Updated dependencies [6b9368a]
- Updated dependencies [89332d5]
- Updated dependencies [f562a1f]
- Updated dependencies [b5ada4d]
- Updated dependencies [8934d8a]
  - cojson@0.20.0
  - cojson-storage-indexeddb@0.20.0
  - cojson-transport-ws@0.20.0

## 0.19.22

### Patch Changes

- 89d8798: Adds a 512 variant for progressive image loading.
- 30b5339: Fix an issue when generating image placeholders from clients using Expo Image Manipulator
- Updated dependencies [3b70482]
- Updated dependencies [6078ea5]
  - cojson@0.19.22
  - cojson-storage-indexeddb@0.19.22
  - cojson-transport-ws@0.19.22

## 0.19.19

### Patch Changes

- 171e1c6: Add Better Auth provider for Svelte
- 053a283: Added `getJazzErrorType` helper function to identify the type of Jazz error from an Error object thrown by suspense hooks. This enables error boundaries to display appropriate UI based on whether the error is "unauthorized", "unavailable", or "unknown".
- 41b2cf4: Context.authenticate now doesn't replace the context if the same AccountID is already logged in
- 923bc8e: Adds Svelte Better Auth support
  Upgrades Better Auth compatibility to version 1.4.7
- 83f84ca: Resume interrupted CoValue sync on app restart (without requiring CoValues to be manually reloaded)
- Updated dependencies [83f84ca]
  - cojson@0.19.19
  - cojson-storage-indexeddb@0.19.19
  - cojson-transport-ws@0.19.19

## 0.19.18

### Patch Changes

- 729d46c: Fixed Clerk types schema to use `.or()` method consistently for union types
  - cojson@0.19.18
  - cojson-storage-indexeddb@0.19.18
  - cojson-transport-ws@0.19.18

## 0.19.17

### Patch Changes

- d46cffd: Bugfix: fixed an issue where calling logOut multiple times concurrently could trigger duplicate logout operations
  - cojson@0.19.17
  - cojson-storage-indexeddb@0.19.17
  - cojson-transport-ws@0.19.17

## 0.19.16

### Patch Changes

- 25268bf: Bugfix: fixed a race condition in Clerk auth where the signup flow could trigger a duplicate login attempt
- Updated dependencies [265d0e9]
  - cojson@0.19.16
  - cojson-storage-indexeddb@0.19.16
  - cojson-transport-ws@0.19.16

## 0.19.15

### Patch Changes

- 94012a1: Added a locking system for session IDs in React Native

  Now it should be safer to mount multiple JazzProviders, but still not advised as it is really expensive

- 86f9676: Adds a createdBy getter
- b27dbc2: Fix Object.keys(coMap.getEdits()) to return also deleted keys
- Updated dependencies [71ed9d6]
  - cojson@0.19.15
  - cojson-storage-indexeddb@0.19.15
  - cojson-transport-ws@0.19.15

## 0.19.14

### Patch Changes

- cojson@0.19.14
- cojson-storage-indexeddb@0.19.14
- cojson-transport-ws@0.19.14

## 0.19.13

### Patch Changes

- bef1cc6: Bugfix: rewrittern the session provider to prevent race conditions and reuse also the new accounts sessions
- b839147: Add schema-level permissions to centralize permission configuration
  - cojson@0.19.13
  - cojson-storage-indexeddb@0.19.13
  - cojson-transport-ws@0.19.13

## 0.19.12

### Patch Changes

- 9ca9e72: Fix the inspector to guess correctly Group's transactions
- 5b0bb7d: Bugfix: ensure that the promises used for Suspense is always cached
- fa0759b: Bugfix: close the server peers before calling the onAnonymousAccountDiscarded hook, to ensure that there won't be conflicting issues with the new context sync
- a2372db: Bugfix: ensure onAnonymousAccountDiscarded hook is conditionally applied in React providers
  - cojson@0.19.12
  - cojson-storage-indexeddb@0.19.12
  - cojson-transport-ws@0.19.12

## 0.19.11

### Patch Changes

- 68acca4: Sync Server is now configurable in inspector.jazz.tools
- c00a454: Resolve footgun in Account.createAs() that made it easy to save the wrong credentials.
- Updated dependencies [c00a454]
  - cojson@0.19.11
  - cojson-storage-indexeddb@0.19.11
  - cojson-transport-ws@0.19.11

## 0.19.10

### Patch Changes

- cojson@0.19.10
- cojson-storage-indexeddb@0.19.10
- cojson-transport-ws@0.19.10

## 0.19.9

### Patch Changes

- d901caa: Added cojson-core-rn that improves ReactNative crypto performance
- a2bb9f0: Added Suspense hooks for React and implemented subscription deduplication for React hooks
- Updated dependencies [d901caa]
  - cojson@0.19.9
  - cojson-storage-indexeddb@0.19.9
  - cojson-transport-ws@0.19.9

## 0.19.8

### Patch Changes

- 21f7d34: Improve error logging in subscriptions and add stacktraces on errors coming from React hooks.

  Added jazzConfig.setCustomErrorReporter API to intercept subscription errors and send them to an error tracker.

- b22ad89: Narrow down `.load` return type to not include `loading` CoValues
- 28b23dd: Added polyfills helper to React Native and Expo exports
- Updated dependencies [93e4a34]
  - cojson@0.19.8
  - cojson-storage-indexeddb@0.19.8
  - cojson-transport-ws@0.19.8

## 0.19.7

### Patch Changes

- e113a79: Avoid migrating unauthorized CoValues
  - cojson@0.19.7
  - cojson-storage-indexeddb@0.19.7
  - cojson-transport-ws@0.19.7

## 0.19.6

### Patch Changes

- 23782f0: Upgraded `react-native-quick-crypto` to version 1.0.0-beta.21 and switch to using the native blake3 in RNQuickCrypto

  Breaking: any app that uses RNQuickCrypto will have to upgrade to `react-native-quick-crypto@1.0.0-beta.21`

- 56d74e4: Make createAs a public API that can be used to create controlled accounts from workers
- bc9120b: - Added value.$jazz.export() API and preloaded option in React hooks, to make it possible to pass raw covalue data from React server components to client components
  - Prevent the inspector from rendering during SSR
  - cojson@0.19.6
  - cojson-storage-indexeddb@0.19.6
  - cojson-transport-ws@0.19.6

## 0.19.5

### Patch Changes

- Updated dependencies [343c2e4]
  - cojson@0.19.5
  - cojson-storage-indexeddb@0.19.5
  - cojson-transport-ws@0.19.5

## 0.19.4

### Patch Changes

- 78dfffd: Optimize CoValue creation by caching schema->coField transformations
- de2f8b5: Ensured ensureLoaded properly handles $onError in resolve queries
- 763977a: In the inspector, accounts are now identified by header's meta type
- e02e14c: Improved readability for CoPlainText's history in inspector
- 3aaba61: Inline edit for CoPlainTexts in inspector
- Updated dependencies [8778937]
  - cojson-storage-indexeddb@0.19.4
  - cojson@0.19.4
  - cojson-transport-ws@0.19.4

## 0.19.3

### Patch Changes

- cddbfdb: Fix co.discriminatedUnion load for React Native
- 114e4ce: Show invalid transaction in inspector even if they are not decryptable
  - cojson@0.19.3
  - cojson-storage-indexeddb@0.19.3
  - cojson-transport-ws@0.19.3

## 0.19.2

### Patch Changes

- ef24afb: Support creating CoVectors using plain `number[]` or `Float32Array` objects inside CoValue containers
- 5f2b34b: Inline editing and snapshot restore for CoMaps in the inspector
- Updated dependencies [7e76313]
  - cojson@0.19.2
  - cojson-storage-indexeddb@0.19.2
  - cojson-transport-ws@0.19.2

## 0.19.1

### Patch Changes

- f444bd9: Add `resolve` support for `co.discriminatedUnion`
- Updated dependencies [afd2ded]
  - cojson@0.19.1
  - cojson-storage-indexeddb@0.19.1
  - cojson-transport-ws@0.19.1

## 0.19.0

### Minor Changes

- 26386d9: Add explicit CoValue loading states:
  - Add `$isLoaded` field to discriminate between loaded and unloaded CoValues
  - Add `$jazz.loadingState` field to provide additional info about the loading state
  - All methods and functions that load CoValues now return a `MaybeLoaded<CoValue>` instead of `CoValue | null | undefined`
  - Rename `$onError: null` to `$onError: "catch"`
  - Split the `useAccount` hook into three separate hooks:
    - `useAccount`: now only returns an Account CoValue
    - `useLogOut`: returns a function for logging out of the current account
    - `useAgent`: returns the current agent
  - Add a `select` option (and an optional `equalityFn`) to `useAccount` and `useCoState`, and remove `useAccountWithSelector` and `useCoStateWithSelector`.
  - Allow specifying resolve queries at the schema level. Those queries will be used when loading CoValues, if no other resolve query is provided.

### Patch Changes

- cojson@0.19.0
- cojson-storage-indexeddb@0.19.0
- cojson-transport-ws@0.19.0

## 0.18.38

### Patch Changes

- 349ca48: feat: Invalid transaction's error messages are now shown in the inspector
- Updated dependencies [349ca48]
- Updated dependencies [68781a0]
  - cojson@0.18.38
  - cojson-storage-indexeddb@0.18.38
  - cojson-transport-ws@0.18.38

## 0.18.37

### Patch Changes

- feecdae: chore: Inspector now prints correctly json fields in covalue history
- a841071: chore: Inspector's raw data and covalue history are now collapsible
- 68e0b26: chore: ErrorBoundary around inspector to handle render errors
- Updated dependencies [0e923d1]
- Updated dependencies [fd89225]
  - cojson@0.18.37
  - cojson-storage-indexeddb@0.18.37
  - cojson-transport-ws@0.18.37

## 0.18.36

### Patch Changes

- Updated dependencies [af3fe4c]
  - cojson@0.18.36
  - cojson-storage-indexeddb@0.18.36
  - cojson-transport-ws@0.18.36

## 0.18.35

### Patch Changes

- Updated dependencies [d47ac6d]
  - cojson@0.18.35
  - cojson-storage-indexeddb@0.18.35
  - cojson-transport-ws@0.18.35

## 0.18.34

### Patch Changes

- 7a64465: fix: Image's lazy loading placeholder transparency in React Image component
- Updated dependencies [4a79953]
- Updated dependencies [d7e5cc8]
  - cojson@0.18.34
  - cojson-storage-indexeddb@0.18.34
  - cojson-transport-ws@0.18.34

## 0.18.33

### Patch Changes

- df0045e: fix: Image's lazy loading placeholder trasparency
- 5ffe0a9: - Wait for the full download of all the dependency graph before running the migrations
  - Re-enable the progressive child key rotation
- Updated dependencies [5ffe0a9]
  - cojson@0.18.33
  - cojson-storage-indexeddb@0.18.33
  - cojson-transport-ws@0.18.33

## 0.18.32

### Patch Changes

- 314c199: feat: CoValue's history is now visible in inspector
- Updated dependencies [8f47a9e]
- Updated dependencies [2c7013a]
  - cojson@0.18.32
  - cojson-transport-ws@0.18.32
  - cojson-storage-indexeddb@0.18.32

## 0.18.31

### Patch Changes

- Updated dependencies [7c2b7b8]
  - cojson@0.18.31
  - cojson-storage-indexeddb@0.18.31
  - cojson-transport-ws@0.18.31

## 0.18.30

### Patch Changes

- b3dbcaa: feat: inspector's group view now shows parents/children groups, with addMember/removeMember features
- 75d452e: Allow users to specify custom placeholders to be used while images are loading
- 346c5fb: Add `.optional()` method to Account schema
- 354895b: Wait for the full download of groups on load and subscribe
- 162757c: Export `z.record` and `z.intersection` as part of jazz-tools
- d08b7e2: feat: introduced new "manager" role who can invite and remove members, and being removed by admins.
- ad19280: fix: visual bug on "delete my local data" button in inspector on mobile viewports
- Updated dependencies [ad83da2]
- Updated dependencies [d08b7e2]
  - cojson@0.18.30
  - cojson-storage-indexeddb@0.18.30
  - cojson-transport-ws@0.18.30

## 0.18.29

### Patch Changes

- cc7efc8: Fix upsertUnique when the account doesn't have access to the value
- f55d17f: fix inspector component in non-React apps
  - cojson@0.18.29
  - cojson-storage-indexeddb@0.18.29
  - cojson-transport-ws@0.18.29

## 0.18.28

### Patch Changes

- 8cbbe0e: Fixed a race condition on upsertUnique that was leading to a "provideHeader" error
- 14806c8: Add `useLogOut` hook
- Updated dependencies [e8880dc]
- Updated dependencies [d83b5e3]
- Updated dependencies [5320349]
  - cojson@0.18.28
  - cojson-storage-indexeddb@0.18.28
  - cojson-transport-ws@0.18.28

## 0.18.27

### Patch Changes

- 6c6eb35: feat: enabled the usage of "expo-image-manipulator" as resize engine in react-native
- 6ca0b59: feat: Add generateAuthToken and authenticateRequest
- 88c5f1c: fix: createImage return type now has the original image already loaded
  - cojson@0.18.27
  - cojson-storage-indexeddb@0.18.27
  - cojson-transport-ws@0.18.27

## 0.18.26

### Patch Changes

- 4e0ea26: Added new CoVector type of CoValue
- Updated dependencies [f956cd3]
  - cojson@0.18.26
  - cojson-storage-indexeddb@0.18.26
  - cojson-transport-ws@0.18.26

## 0.18.25

### Patch Changes

- 4036737: "peersToLoadFrom" renamed to only "peers"
- 8ae7d71: feat: AuthSecretStorage's key is now configurable to handle multiple Jazz's apps on the same origin
- b1d0081: Simplified getting invite secrets for groups
- 36a5c58: Don't log unavailable errors when `loadUnique` or `upsertUnique` are used
- 94e7d89: Added more options to the create-jazz-app tool
- Updated dependencies [4036737]
  - cojson@0.18.25
  - cojson-storage-indexeddb@0.18.25
  - cojson-transport-ws@0.18.25

## 0.18.24

### Patch Changes

- f4c4ee9: fix: Account.create() type now accepts peersToLoadFrom and initialAgentSecret"
- a15e2ba: Expose subscription scope react hooks and new `createCoValueSubscriptionContext` and `createAccountSubscriptionContext` helper functions
- Updated dependencies [b09785e]
  - cojson@0.18.24
  - cojson-storage-indexeddb@0.18.24
  - cojson-transport-ws@0.18.24

## 0.18.23

### Patch Changes

- a0c8a2d: fix napi crypto export
  - cojson@0.18.23
  - cojson-storage-indexeddb@0.18.23
  - cojson-transport-ws@0.18.23

## 0.18.22

### Patch Changes

- 22200ac: Inspector now shows the CoID of list items and handles unavailable items correctly
- 1e20db6: Added cojson-core-napi
- Updated dependencies [1e20db6]
  - cojson@0.18.22
  - cojson-storage-indexeddb@0.18.22
  - cojson-transport-ws@0.18.22

## 0.18.21

### Patch Changes

- 6819f20: Implements SSR options for SvelteKit
  - cojson@0.18.21
  - cojson-storage-indexeddb@0.18.21
  - cojson-transport-ws@0.18.21

## 0.18.20

### Patch Changes

- c34a793: Allow usage of z.codec with custom encoders in CoValues
- 2c01529: Increased passkey challenge length to improve compatibility with KeePassXC
- 7b0facc: Upgrade Zod to 4.1
- 47c7dd3: fix: regenerate InboxSender when active account changes
- d0e2210: Batch subscribe updates during the applyDiff execution
- Updated dependencies [e75b3d6]
- Updated dependencies [ecf4967]
- Updated dependencies [d0e2210]
  - cojson@0.18.20
  - cojson-storage-indexeddb@0.18.20
  - cojson-transport-ws@0.18.20

## 0.18.19

### Patch Changes

- f88db5f: Ensure subscription scope is cached for each CoValue
- 8eac2fc: Fix refs in partially loaded CoMaps being incorrectly marked as optional
- 08b6c03: fix: keep sync between Better Auth's session and Jazz's
  - cojson@0.18.19
  - cojson-storage-indexeddb@0.18.19
  - cojson-transport-ws@0.18.19

## 0.18.18

### Patch Changes

- f2f478a: Add connection status API for React and Svelte
  - **React**: Added `useSyncConnectionStatus()` hook that returns the current connection status to the Jazz sync server
  - **Svelte**: Added `SyncConnectionStatus` class that provides reactive connection status monitoring

- ed7e353: Bugfix: wait for full streaming before triggering migrations on comap
- 1698d41: Add `unstable_branch` option to useAccountWithSelector
- Updated dependencies [ed7e353]
  - cojson@0.18.18
  - cojson-storage-indexeddb@0.18.18
  - cojson-transport-ws@0.18.18

## 0.18.17

### Patch Changes

- 75d1afa: Fix an issue where a flash of alt text displays while an image definition is loading from storage
- 8aa4acd: Optimized the inactive subscriptions, improving performance of updates on created and loaded values by 2.5x
- Updated dependencies [925da72]
  - cojson@0.18.17
  - cojson-storage-indexeddb@0.18.17
  - cojson-transport-ws@0.18.17

## 0.18.16

### Patch Changes

- 67b95b7: Introduced new Better Auth database adapter based on Jazz
  - cojson@0.18.16
  - cojson-storage-indexeddb@0.18.16
  - cojson-transport-ws@0.18.16

## 0.18.15

### Patch Changes

- a584ab3: Add WasmCrypto support for Cloudflare Workers and edge runtimes by importing `jazz-tools/load-edge-wasm`.
  - Enable WasmCrypto functionality by initializing the WebAssembly environment with the import: `import "jazz-tools/load-edge-wasm"` in edge runtimes.
  - Guarantee compatibility across Cloudflare Workers and other edge runtime environments.

- Updated dependencies [a584ab3]
  - cojson@0.18.15
  - cojson-storage-indexeddb@0.18.15
  - cojson-transport-ws@0.18.15

## 0.18.14

### Patch Changes

- a04435e: Optimized updates on large subscriptions
  - cojson@0.18.14
  - cojson-storage-indexeddb@0.18.14
  - cojson-transport-ws@0.18.14

## 0.18.13

### Patch Changes

- 2ddf4d9: Introducing version control APIs, unstable_branch and unstable_merge

  Flagged as unstable because branch & merge scope & propagation needs to be validated.

- 45981cf: Add co.group schema definer
- Updated dependencies [48837f2]
- Updated dependencies [2ddf4d9]
  - cojson@0.18.13
  - cojson-storage-indexeddb@0.18.13
  - cojson-transport-ws@0.18.13

## 0.18.12

### Patch Changes

- c16ce4b: Fix addMember with account owners, by detecting the accounts from their raw value
- 0b1b050: Export ReactNativeContextManager from react-native-core
  - cojson@0.18.12
  - cojson-storage-indexeddb@0.18.12
  - cojson-transport-ws@0.18.12

## 0.18.11

### Patch Changes

- 06b4617: Update the Svelte InviteListener to listen to hash change events
- 70eb465: Add docs to the worker API and deprecate done in favor of shutdownWorker
- Updated dependencies [a4a9a1e]
  - cojson@0.18.11
  - cojson-storage-indexeddb@0.18.11
  - cojson-transport-ws@0.18.11

## 0.18.10

### Patch Changes

- Updated dependencies [95cc9af]
  - cojson-transport-ws@0.18.10
  - cojson@0.18.10
  - cojson-storage-indexeddb@0.18.10

## 0.18.9

### Patch Changes

- c8167de: fix: improve handling of concurrent authentication attempts in ContextManager
- 910b8d6: Added useAccountWithSelector hook for granular account data selection with custom equality checking
- Updated dependencies [f058875]
  - cojson@0.18.9
  - cojson-storage-indexeddb@0.18.9
  - cojson-transport-ws@0.18.9

## 0.18.8

### Patch Changes

- 700fe46: fix: in 32d1444 was used the wrong Better Auth internal function to delete old verification codes
- aba0d55: Support the selection of a subset of keys to make optional in `co.map().partial()`
- Updated dependencies [9a4caf2]
  - cojson@0.18.8
  - cojson-storage-indexeddb@0.18.8
  - cojson-transport-ws@0.18.8

## 0.18.7

### Patch Changes

- cf26739: Add `useCoStateWithSelector` for granular reactivity
- a3cd9c8: Add lastUpdatedAt & createdAt properties to $jazz in all the coValue types
- ca5cd26: Make CoLists structurally equal to arrays
- 32d1444: fix: ensure better-auth email-otp verification uniqueness
- Updated dependencies [c2d8bf7]
- Updated dependencies [dccb464]
- Updated dependencies [a3cd9c8]
- Updated dependencies [e8e7bf8]
- Updated dependencies [51d3558]
  - cojson@0.18.7
  - cojson-storage-indexeddb@0.18.7
  - cojson-transport-ws@0.18.7

## 0.18.6

### Patch Changes

- 975d1c3: Fixed the startWorker type to return a shallowly-loaded worker account.
- ccbb795: Add skipInboxLoad option to startWorker
- 0dae338: Add concurrency limit on the Inbox subscribe, and simplify the failed messages management
- 934679c: feat: Better Auth EmailOTP plugin is now supported
- 28defd0: Fix peer role to be client when connecting the test accounts to the test sync server
- e0f17ed: Fix the react dependency error when loading the inspector as custom element
- 88ef339: fix: removed unwanted browser dependency in order to make better-auth provider works on react-native
- Updated dependencies [9e792c7]
  - cojson@0.18.6
  - cojson-storage-indexeddb@0.18.6
  - cojson-transport-ws@0.18.6

## 0.18.5

### Patch Changes

- ff35d8c: fix: accountID property presence on typescript for Better Auth user's shape
- f23a7a7: fix: Jazz credentials were not properly retrieved during SSO flows in Better Auth
- f5d8424: Fallback to random session when running Jazz in a browser without navigator.lock support
- 4e976b8: Added the co.input convenience type, to easily extract the create payload type.
  - cojson@0.18.5
  - cojson-storage-indexeddb@0.18.5
  - cojson-transport-ws@0.18.5

## 0.18.4

### Patch Changes

- 84313aa: Add `$jazz.id` to `toJSON` in Account, CoMap, CoFeed & FileStream
- 89aab7b: Deprecate `co.map().catchall`. Use a `co.record` nested inside a `co.map` if you need to store key-value properties.
  - cojson@0.18.4
  - cojson-storage-indexeddb@0.18.4
  - cojson-transport-ws@0.18.4

## 0.18.3

### Patch Changes

- b526ab6: Set 18.x as latest
- d69aa68: Added a server implementation of `createImage()` to create images in server environments using the "sharp" library
  - cojson@0.18.3
  - cojson-storage-indexeddb@0.18.3
  - cojson-transport-ws@0.18.3

## 0.18.2

### Patch Changes

- Updated dependencies [82ba2dd]
- Updated dependencies [01f4889]
  - cojson@0.18.2
  - cojson-storage-indexeddb@0.18.2
  - cojson-transport-ws@0.18.2

## 0.18.1

### Patch Changes

- af5fbe7: New BetterAuth plugins to store Jazz's credentials
- 9837459: Add `CoMap.$jazz.has` and `Account.$jazz.has` method to check for property existance without loading referenced CoValues or checking permissions
  - cojson@0.18.1
  - cojson-storage-indexeddb@0.18.1
  - cojson-transport-ws@0.18.1

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

- Updated dependencies [b709494]
- Updated dependencies [f263856]
  - cojson@0.18.0
  - cojson-storage-indexeddb@0.18.0
  - cojson-transport-ws@0.18.0

## 0.17.14

### Patch Changes

- cc2f774: Detect incompatible Zod schemas when creating `co.map`s and `co.profile`s
- Updated dependencies [1094b7c]
- Updated dependencies [6378ad5]
  - cojson@0.17.14
  - cojson-storage-indexeddb@0.17.14
  - cojson-transport-ws@0.17.14

## 0.17.13

### Patch Changes

- d208cd1: Add remove action for CoList table in the inspector
- 7821a8b: fix: sign out Jazz account when signing out from Clerk
- Updated dependencies [7dc3160]
- Updated dependencies [474881d]
  - cojson@0.17.13
  - cojson-storage-indexeddb@0.17.13
  - cojson-transport-ws@0.17.13

## 0.17.12

### Patch Changes

- 1ccae1a: RN Expo E2E dependency fixes w catalog
- Updated dependencies [c2daf3e]
- Updated dependencies [72a63bf]
- Updated dependencies [234bf91]
  - cojson@0.17.12
  - cojson-storage-indexeddb@0.17.12
  - cojson-transport-ws@0.17.12

## 0.17.11

### Patch Changes

- 8f3852b: Accept { $onError: null } as resolve query for co.list references
- bb9d837: Explicit loadAs in CoList.upsertUnique to use it without loaded context
- Updated dependencies [68b2f37]
- Updated dependencies [257ded3]
- Updated dependencies [e301ad6]
  - cojson@0.17.11
  - cojson-storage-indexeddb@0.17.11
  - cojson-transport-ws@0.17.11

## 0.17.10

### Patch Changes

- Updated dependencies [c55297c]
  - cojson@0.17.10
  - cojson-storage-indexeddb@0.17.10
  - cojson-transport-ws@0.17.10

## 0.17.9

### Patch Changes

- 52ea0c7: Explicit loadAs in upsertUnique to use it without loaded context
- Updated dependencies [7586c3b]
  - cojson@0.17.9
  - cojson-storage-indexeddb@0.17.9
  - cojson-transport-ws@0.17.9

## 0.17.8

### Patch Changes

- ac3e694: Fixed an issue where CoValue schemas could be incorrectly passed to `co.map` and `co.profile` schema definers.
- 6dbb053: Prosemirror: fix RangeError triggered when creating invalid HTML
- 1a182f0: Add missing BaseProfileShape export
  - cojson@0.17.8
  - cojson-storage-indexeddb@0.17.8
  - cojson-transport-ws@0.17.8

## 0.17.7

### Patch Changes

- cojson@0.17.7
- cojson-storage-indexeddb@0.17.7
- cojson-transport-ws@0.17.7

## 0.17.6

### Patch Changes

- 82de51c: allow creating CoValues from JSON without an active account
- 694b168: get resized image's id without triggering shallow load in `loadImageBySize`
  - cojson@0.17.6
  - cojson-storage-indexeddb@0.17.6
  - cojson-transport-ws@0.17.6

## 0.17.5

### Patch Changes

- 5963658: Implement/expose loadUnique and upsertUnique on co.list and co.record
- Updated dependencies [71c1411]
- Updated dependencies [2d11d44]
  - cojson@0.17.5
  - cojson-storage-indexeddb@0.17.5
  - cojson-transport-ws@0.17.5

## 0.17.4

### Patch Changes

- 7dd3d00: Export `Ref` class from jazz-tools package
  - cojson@0.17.4
  - cojson-storage-indexeddb@0.17.4
  - cojson-transport-ws@0.17.4

## 0.17.3

### Patch Changes

- Updated dependencies [f0c73d9]
  - cojson@0.17.3
  - cojson-storage-indexeddb@0.17.3
  - cojson-transport-ws@0.17.3

## 0.17.2

### Patch Changes

- 794681a: fix unused blob creation on react Image component
- 83fc22f: React Native resizer is now imported dynamically, as it is an optional dependency
- Updated dependencies [5b2b16a]
  - cojson@0.17.2
  - cojson-storage-indexeddb@0.17.2
  - cojson-transport-ws@0.17.2

## 0.17.1

### Patch Changes

- 0bcbf55: Export the HttpRoute type
- d1bdbf5: fix: ensure file downloaded in loadImageBySize
- 4b73834: fix(jazz-tools/svelte): Make Image reactive to imageId change
- Updated dependencies [2fd88b9]
  - cojson@0.17.1
  - cojson-storage-indexeddb@0.17.1
  - cojson-transport-ws@0.17.1

## 0.17.0

### Minor Changes

- fcaf4b9: New image management APIs, refactoring imperative functions for creation and consumption, React and ReactNative components, and new Svelte componente

### Patch Changes

- cojson@0.17.0
- cojson-storage-indexeddb@0.17.0
- cojson-transport-ws@0.17.0

## 0.16.6

### Patch Changes

- 67e0968: Fix content streaming chunking, now chunks should be splitted always respecting the MAX_RECOMMENDED_TX_SIZE
- 2c8120d: co.record partial deep loading now resolve correct type
- Updated dependencies [103d1b4]
- Updated dependencies [67e0968]
- Updated dependencies [ce9ca54]
- Updated dependencies [4b99ff1]
- Updated dependencies [ac5d20d]
- Updated dependencies [9bf7946]
  - cojson-storage-indexeddb@0.16.6
  - cojson@0.16.6
  - cojson-transport-ws@0.16.6

## 0.16.5

### Patch Changes

- 3cd1586: Makes the key rotation not fail when child groups are unavailable or their readkey is not accessible.

  Also changes the Group.removeMember method to not return a Promise, because:
  - All the locally available child groups are rotated immediately
  - All the remote child groups are rotated in background, but since they are not locally available the user won't need the new key immediately

- 33ebbf0: Fix error when using nested discriminatedUnion
- Updated dependencies [3cd1586]
- Updated dependencies [267f689]
  - cojson@0.16.5
  - cojson-storage-indexeddb@0.16.5
  - cojson-transport-ws@0.16.5

## 0.16.4

### Patch Changes

- 16764f6: Added `pick()` and `partial()` methods to CoMapSchema
- Updated dependencies [f9d538f]
- Updated dependencies [802b5a3]
  - cojson@0.16.4
  - cojson-storage-indexeddb@0.16.4
  - cojson-transport-ws@0.16.4

## 0.16.3

### Patch Changes

- 43d3511: Streamlined CoValue creation:
  - CoValues can be created with plain JSON objects. Nested CoValues will be automatically created when necessary.
  - Optional fields can be ommited (i.e. it's no longer necessary to provide an explicit `undefined` value).
  - cojson@0.16.3
  - cojson-storage-indexeddb@0.16.3
  - cojson-transport-ws@0.16.3

## 0.16.2

### Patch Changes

- cojson@0.16.2
- cojson-storage-indexeddb@0.16.2
- cojson-transport-ws@0.16.2

## 0.16.1

### Patch Changes

- c62abef: Add support for nullable non-collaborative fields
  - cojson@0.16.1
  - cojson-storage-indexeddb@0.16.1
  - cojson-transport-ws@0.16.1

## 0.16.0

### Minor Changes

- c09dcdf: Change the root attribute to be public on Account. The root content will still follow the visiblity rules specified in their group.

  Existing accounts will be gradually migrated as they are loaded.

- 2bbb07b: Introduce a cleaner separation between Zod and CoValue schemas:
  - Zod schemas and CoValue schemas are fully separated. Zod schemas can only be composed with other Zod schemas. CoValue schemas can be composed with either Zod or other CoValue schemas.
  - `z.optional()` and `z.discriminatedUnion()` no longer work with CoValue schemas. Use `co.optional()` and `co.discriminatedUnion()` instead.
  - Internal schema access is now simpler. You no longer need to use Zod’s `.def` to access internals. Use properties like `CoMapSchema.shape`, `CoListSchema.element`, and `CoOptionalSchema.innerType` directly.
  - CoValue schema types are now namespaced under `co.`. Non-namespaced exports have been removed
  - CoMap schemas no longer incorrectly inherit from Zod. Previously, methods like `.extend()` and `.partial()` appeared available but could cause unexpected behavior. These methods are now disabled. In their place, `.optional()` has been added, and more Zod-like methods will be introduced in future releases.
  - Upgraded Zod from `3.25.28` to `3.25.76`.
  - Removed deprecated `withHelpers` method from CoValue schemas
  - Removed deprecated `createCoValueObservable` function

### Patch Changes

- Updated dependencies [c09dcdf]
  - cojson@0.16.0
  - cojson-storage-indexeddb@0.16.0
  - cojson-transport-ws@0.16.0

## 0.15.16

### Patch Changes

- 9633d01: Introduced a new HTTP based API to talk with Server Workers
- 4beafb7: Fix property update when assigning an optional reference on CoMap
  - cojson@0.15.16
  - cojson-storage-indexeddb@0.15.16
  - cojson-transport-ws@0.15.16

## 0.15.15

### Patch Changes

- 3fe53a3: Fix property update when assigning an optional reference on CoMap
  - cojson@0.15.15
  - cojson-storage-indexeddb@0.15.15
  - cojson-transport-ws@0.15.15

## 0.15.14

### Patch Changes

- a584590: Prevent resolving discriminated union fields
- 9acccb5: Export `WithHelpers` type used in CoValue schemas
- Updated dependencies [70ce7c5]
  - cojson-transport-ws@0.15.14
  - cojson@0.15.14
  - cojson-storage-indexeddb@0.15.14

## 0.15.13

### Patch Changes

- 6c76ff8: Fix load failures when loading a missing ref declared with z.optional and Schema.optional
  - cojson@0.15.13
  - cojson-storage-indexeddb@0.15.13
  - cojson-transport-ws@0.15.13

## 0.15.12

### Patch Changes

- d1c1b0c: Fix stuck authentication when using onAnonymousAccountDiscarded with a storage
- cf4ad72: fix unhandled rejection on CoValue.load
  - cojson@0.15.12
  - cojson-storage-indexeddb@0.15.12
  - cojson-transport-ws@0.15.12

## 0.15.11

### Patch Changes

- bdc9aee: - Add `co.optional` and `co.discriminatedUnion`. You can now `load` and `subcribe` to schemas created with `co.discriminatedUnion`.
  - Improved type-checking around `z.` schemas to prevent invalid combinations with `co.` schemas.
  - cojson@0.15.11
  - cojson-storage-indexeddb@0.15.11
  - cojson-transport-ws@0.15.11

## 0.15.10

### Patch Changes

- 9815ec6: Export the z.ZodDiscriminatedUnion type
- b4fdab4: Exposed the current Account's ID in unauthorized error message
  - cojson@0.15.10
  - cojson-storage-indexeddb@0.15.10
  - cojson-transport-ws@0.15.10

## 0.15.9

### Patch Changes

- 27b4837: Wait for the full streaming before return values in load and subscribe
- Updated dependencies [27b4837]
- Updated dependencies [2776263]
  - cojson@0.15.9
  - cojson-storage-indexeddb@0.15.9
  - cojson-transport-ws@0.15.9

## 0.15.8

### Patch Changes

- 3844666: Refactor AccountSchema types to solve "This is likely not portable. A type annotation is necessary" issue when using co.account()
  - cojson@0.15.8
  - cojson-storage@0.15.8
  - cojson-storage-indexeddb@0.15.8
  - cojson-transport-ws@0.15.8

## 0.15.7

### Patch Changes

- c09b636: Fix react bundling in jazz-tools/inspector/register-custom-element
  - cojson@0.15.7
  - cojson-storage@0.15.7
  - cojson-storage-indexeddb@0.15.7
  - cojson-transport-ws@0.15.7

## 0.15.6

### Patch Changes

- a5ceaff: add Group.getDirectMembers to get only direct members of a group
  - cojson@0.15.6
  - cojson-storage@0.15.6
  - cojson-storage-indexeddb@0.15.6
  - cojson-transport-ws@0.15.6

## 0.15.5

### Patch Changes

- 23bfea5: Make all React Native dependencies in `jazz-tools` optional peer dependencies
- e4ba23c: Fix type error with `RNQuickCrypto` that prevented using it as a `CryptoProvider`
- 4b89838: Changes that verify the BetterAuth package for React also works with React Native and Expo apps
  - cojson@0.15.5
  - cojson-storage@0.15.5
  - cojson-storage-indexeddb@0.15.5
  - cojson-transport-ws@0.15.5

## 0.15.4

### Patch Changes

- Updated dependencies [277e4d4]
  - cojson@0.15.4
  - cojson-storage@0.15.4
  - cojson-storage-indexeddb@0.15.4
  - cojson-transport-ws@0.15.4

## 0.15.3

### Patch Changes

- 45f73a7: fix image `originalSize` to be coherent with the highest resolution
- Updated dependencies [535c460]
  - cojson-storage-indexeddb@0.15.3
  - cojson@0.15.3
  - cojson-storage@0.15.3
  - cojson-transport-ws@0.15.3

## 0.15.2

### Patch Changes

- 0e7e532: inspector: improve CoPlainText view
- Updated dependencies [4b964ed]
  - cojson@0.15.2
  - cojson-storage@0.15.2
  - cojson-storage-indexeddb@0.15.2
  - cojson-transport-ws@0.15.2

## 0.15.1

### Patch Changes

- 0e3a4d2: Add FileStream.loadAsBase64 API
- b110f00: Added `CoMap.upsertUnique` & `CoMap.loadUnique` methods (deprecating `CoMap.findUnique`) and added `skipRetry` option to `CoMap.load`
- Updated dependencies [b110f00]
  - cojson@0.15.1
  - cojson-storage@0.15.1
  - cojson-storage-indexeddb@0.15.1
  - cojson-transport-ws@0.15.1

## 0.15.0

### Minor Changes

- 1378a1f: Moved all the framework adapters in jazz-tools to simplify dependency management
- 0fa051a: Remove the experimental prefix from enableSSR, change the useAccount type to make me always nullable and remove useAccountOrGuest

### Patch Changes

- cojson@0.15.0
- cojson-storage@0.15.0
- cojson-storage-indexeddb@0.15.0
- cojson-transport-ws@0.15.0

## 0.14.28

### Patch Changes

- 06c5a1c: Resolve FileStream.load() only when the stream is fully downloaded
  - cojson@0.14.28

## 0.14.27

### Patch Changes

- a026073: Export CoRecordSchema & CoProfileSchema types
  - cojson@0.14.27

## 0.14.26

### Patch Changes

- Updated dependencies [e74a077]
  - cojson@0.14.26

## 0.14.25

### Patch Changes

- 99a2d9b: Deprecated `Group.extend` and `Group.revokeExtend` (use `Group.addMember` and `Group.removeMember` respectively)
  - cojson@0.14.25

## 0.14.24

### Patch Changes

- cojson@0.14.24

## 0.14.23

### Patch Changes

- 9177579: Fixs coText applyDiff out of bounds insertion with emoji
- Updated dependencies [1ca9299]
  - cojson@0.14.23

## 0.14.22

### Patch Changes

- 048ac1d: Fix: Ensure the types on withMigration expect a shallowly loaded Account
- Updated dependencies [57fb69f]
  - cojson@0.14.22

## 0.14.21

### Patch Changes

- e7e505e: Adds `makePublic(role)` alias for `group.addMember("everyone", role)`
- 13b57aa: Fix creation of z.discriminatedUnions of CoValue schemas in Inbox and other places
- 5662faa: Add `_createdAt` and `_lastUpdatedAt` getters for CoMaps
- 2116a59: Improve SubscriptionScope.getCurrentValue to be the basis of the new React integration
- Updated dependencies [c3d8779]
  - cojson@0.14.21

## 0.14.20

### Patch Changes

- 6f72419: Add support for per-CoMap migrations
- 04b20c2: Make Zod schemas compatible with castAs
  - cojson@0.14.20

## 0.14.19

### Patch Changes

- cojson@0.14.19

## 0.14.18

### Patch Changes

- 4b950bc: Fixes support for recursive props on co.profile and for co.image inside z.discriminatedUnion
- d6d9c0a: Make checks on the discriminator field on z.discriminatedUnion more specific and less strict
- c559054: Add support for optional dates
- Updated dependencies [0d5ee3e]
  - cojson@0.14.18

## 0.14.17

### Patch Changes

- e512df4: Move to latest stable version of Zod

## 0.14.16

### Patch Changes

- Updated dependencies [5e253cc]
  - cojson@0.14.16

## 0.14.15

### Patch Changes

- Updated dependencies [23daa7c]
  - cojson@0.14.15

## 0.14.14

### Patch Changes

- e32a1f7: Add useAnonymousFallback option in JazzContextManager

## 0.14.10

### Patch Changes

- dc746a2: Make the react peerDependency definition more relaxed
- f869d9a: Deprecated the withHelpers method in favor of standalone functions
- 3fe6832: Add support for z.catch/default. We ignore them for the moment and flag a warning.

## 0.14.9

### Patch Changes

- 22c2600: Move back to zod as dependency and clean up zod re-export

## 0.14.8

### Patch Changes

- 637ae13: Use our Zod v4 fork with the React Native fixes

## 0.14.7

### Patch Changes

- 365b0ea: reduce the z exported APIs to the ones we support and fix compatible types

## 0.14.6

### Patch Changes

- 9d6d9fe: Fixes co.fileStream create and createFromBlob types
- 9d6d9fe: Fixes init type for CoList, CoFeed and CoRecord to accept optional partially loaded values

## 0.14.5

### Patch Changes

- 91cbb2f: Fix CoMap.create with optional types
- 20b3d88: Add co.loaded utility

## 0.14.4

### Patch Changes

- 011af55: Support z.enum in the schema definitions

## 0.14.2

### Patch Changes

- 3d1027f: Make possible to extend a group without having access to it
- c240eed: Fix custom AccountSchema support in testing utils

## 0.14.1

### Patch Changes

- cdfc105: Make the profile access on Group members trigger updates correctly
- Updated dependencies [c8b33ad]
  - cojson@0.14.1

## 0.14.0

### Minor Changes

- 5835ed1: Switch to using Zod to define CoValue schemas

### Patch Changes

- Updated dependencies [5835ed1]
  - cojson@0.14.0

## 0.13.31

### Patch Changes

- e5b170f: Add $onError option to resolve, to be able to catch errors inside of the deep loading
- Updated dependencies [d63716a]
- Updated dependencies [d5edad7]
  - cojson@0.13.31

## 0.13.30

### Patch Changes

- Updated dependencies [07dd2c5]
  - cojson@0.13.30

## 0.13.29

### Patch Changes

- Updated dependencies [eef1a5d]
- Updated dependencies [191ae38]
- Updated dependencies [daee7b9]
  - cojson@0.13.29

## 0.13.28

### Patch Changes

- Updated dependencies [e7ccb2c]
  - cojson@0.13.28

## 0.13.27

### Patch Changes

- Updated dependencies [6357052]
  - cojson@0.13.27

## 0.13.26

### Patch Changes

- ff846d9: Fix loading accounts with the new subscription engine

## 0.13.25

### Patch Changes

- Updated dependencies [a846e07]
  - cojson@0.13.25

## 0.13.23

### Patch Changes

- 02a240c: Add getMetadata to fileStream to easily get file metadata
- Updated dependencies [6b781cf]
  - cojson@0.13.23

## 0.13.21

### Patch Changes

- Updated dependencies [e14e61f]
  - cojson@0.13.21

## 0.13.20

### Patch Changes

- 439f0fe: Adds creation owner and consume-as-string shorthands to `CoPlainText`
- Updated dependencies [adfc9a6]
- Updated dependencies [1389207]
- Updated dependencies [d6e143e]
- Updated dependencies [3e6229d]
  - cojson@0.13.20

## 0.13.19

### Patch Changes

- 80530a4: Improve error management for autoloaded values and fix autoloading on $each resolve

## 0.13.18

### Patch Changes

- 761759c: Full rewrite of the subscription engine, bringing more stability and better performance.
- Updated dependencies [9089252]
- Updated dependencies [b470f63]
- Updated dependencies [66373ba]
- Updated dependencies [f24cad1]
  - cojson@0.13.18

## 0.13.17

### Patch Changes

- Updated dependencies [9fb98e2]
- Updated dependencies [0b89fad]
  - cojson@0.13.17

## 0.13.16

### Patch Changes

- Updated dependencies [c6fb8dc]
  - cojson@0.13.16

## 0.13.15

### Patch Changes

- Updated dependencies [c712ef2]
  - cojson@0.13.15

## 0.13.14

### Patch Changes

- Updated dependencies [5c2c7d4]
  - cojson@0.13.14

## 0.13.13

### Patch Changes

- Updated dependencies [ec9cb40]
  - cojson@0.13.13

## 0.13.12

### Patch Changes

- 4547525: Skip non-schema related keys when calling CoMap.toJSON
- Updated dependencies [65719f2]
  - cojson@0.13.12

## 0.13.11

### Patch Changes

- 17273a6: CoRichText released
- Updated dependencies [17273a6]
- Updated dependencies [3396ed4]
- Updated dependencies [267ea4c]
  - cojson@0.13.11

## 0.13.10

### Patch Changes

- Updated dependencies [f837cfe]
  - cojson@0.13.10

## 0.13.9

### Patch Changes

- a6cf01f: Handle null values on CoList when using $each: true

## 0.13.7

### Patch Changes

- bc3d7bb: Allow to assign the writeOnly role to everyone
- Updated dependencies [bc3d7bb]
- Updated dependencies [4e9aae1]
- Updated dependencies [21c935c]
- Updated dependencies [aa1c80e]
- Updated dependencies [13074be]
  - cojson@0.13.7

## 0.13.5

### Patch Changes

- fe6f561: Gracefully handle unavailable messages error in the Inbox
- Updated dependencies [e090b39]
  - cojson@0.13.5

## 0.13.4

### Patch Changes

- 3129982: Add logOutReplacement hook to replace the Jazz logout function with a custom one

## 0.13.3

### Patch Changes

- 12f8bfa: Log permission errors when loading or subscribing to values
- bd57177: Handle null properties in the CoMap deep loading

## 0.13.2

### Patch Changes

- Updated dependencies [c551839]
  - cojson@0.13.2

## 0.13.0

### Patch Changes

- afd1374: Accept null as initial value for createCoValueObservable
- Updated dependencies [a013538]
- Updated dependencies [bce3bcc]
  - cojson@0.13.0

## 0.12.2

### Patch Changes

- Updated dependencies [c2f4827]
  - cojson@0.12.2

## 0.12.1

### Patch Changes

- Updated dependencies [5a00fe0]
  - cojson@0.12.1

## 0.12.0

### Minor Changes

- 01523dc: Check CoValue access permissions when loading
- 4ea87dc: Implement new API for deep loading
- 1e6da19: The .load function now returns `null` on error

### Patch Changes

- b6c6a0a: Make the linkAccounts test utility wait for the accounts coValues to be synced
- Updated dependencies [01523dc]
- Updated dependencies [01523dc]
  - cojson@0.12.0

## 0.11.8

### Patch Changes

- Updated dependencies [6c86c4f]
- Updated dependencies [9d0c9dc]
  - cojson@0.11.8

## 0.11.7

### Patch Changes

- a140f55: Bugfix: Trigger a single update when loading a locally available list of items
- 2b0d1b0: Export CoFeedEntry type
- Updated dependencies [2b94bc8]
- Updated dependencies [2957362]
  - cojson@0.11.7

## 0.11.6

### Patch Changes

- e7c85b7: Add targetWidth to highestResAvailable to add a way to fetch the next size up
- Updated dependencies [8ed144e]
  - cojson@0.11.6

## 0.11.5

### Patch Changes

- Updated dependencies [60f5b3f]
  - cojson@0.11.5

## 0.11.4

### Patch Changes

- 57a3dbe: Throw when assigning invalid values to ref fields
- a717754: Use RegisteredAccount types for `by` props
- a91f343: Fixes coList.splice to handle insertions at start of list
- Updated dependencies [7f036c1]
  - cojson@0.11.4

## 0.11.3

### Patch Changes

- Updated dependencies [68b0242]
  - cojson@0.11.3

## 0.11.2

### Patch Changes

- 6892dc6: Adds `applyDiff` to `CoList`

## 0.11.0

### Minor Changes

- b9d194a: Make members return inherited members
  Added getRoleOf method to Account and Group
  Added canRead, canWrite, canAdmin methods to Account so simplify permissions checks
- 34cbdc3: Added revokeExtend method to Group
- f039e8f: Remove co.members and use RegisteredAccount and the configured AccountSchema to setup the members Account class. Remove everyone from Group.members results
- e22de9f: Fix profile migrations

### Patch Changes

- 6a96d8b: Add getParentGroups API to Group
- a35249a: Fix CoMap.toJSON() with encoded fields
- a4713df: Moving to the d.ts files for the exported type definitions
- Updated dependencies [b9d194a]
- Updated dependencies [a4713df]
- Updated dependencies [e22de9f]
- Updated dependencies [34cbdc3]
- Updated dependencies [0f67e0a]
  - cojson@0.11.0

## 0.10.15

### Patch Changes

- 2f99de0: Avoid race conditions on context creation and run the anonymous migration only when the hook is provided
- Updated dependencies [f86e278]
  - cojson@0.10.15

## 0.10.14

### Patch Changes

- 75211e3: Fixes invalid authentication state when logging out after signUp

## 0.10.13

### Patch Changes

- 07feedd: Add registerNewUser and generateRandomPassphrase methods to PasskeyAuth and accept the username param on the signUp function

## 0.10.12

### Patch Changes

- 4612e05: Fix type inference on `useCoState`

## 0.10.8

### Patch Changes

- 2fb6428: Allow explicit keys when loading values from a CoMap.Record and throw when a required ref is undefined
- Updated dependencies [153dc99]
  - cojson@0.10.8

## 0.10.7

### Patch Changes

- 1136d9b: Fixed isAuthenticated out-of-sync with the account state during the logOut and authenticate flows
- 0eed228: Fixes clerk auth flow
- Updated dependencies [0f83320]
- Updated dependencies [012022d]
  - cojson@0.10.7

## 0.10.6

### Patch Changes

- ada802b: Fix Clerk credentials migration
- Updated dependencies [5c76e37]
  - cojson@0.10.6

## 0.10.5

### Patch Changes

- 59ff77e: Critical fix: move the Account migration code execution in the right place to ensure that the changes applied to the right Jazz node.

## 0.10.4

### Patch Changes

- Updated dependencies [1af6072]
  - cojson@0.10.4

## 0.10.3

### Patch Changes

- d8582fc: Fixes coField.optional.Date throwing when assigned undefined

## 0.10.2

### Patch Changes

- Updated dependencies [cae3a9e]
  - cojson@0.10.2

## 0.10.1

### Patch Changes

- 5a63cba: Not re-export Crypto providers from cojson. Removed the separated bundle for React Native.
- Updated dependencies [5a63cba]
  - cojson@0.10.1

## 0.10.0

### Minor Changes

- 498954f: Introducing the new auth system!
- dd03464: Group.addMember and Group.removeMember are not chainable anymore.
  Group.removeMember now returns the internal promise.
- b426342: Return null when a coValue is not found

### Patch Changes

- d42c2aa: Make ensureLoaded throw when the resolved value is undefined
- Updated dependencies [b426342]
- Updated dependencies [498954f]
- Updated dependencies [8217981]
- Updated dependencies [ac3d9fa]
- Updated dependencies [610543c]
  - cojson@0.10.0

## 0.9.23

### Patch Changes

- Updated dependencies [70c9a5d]
  - cojson@0.9.23

## 0.9.21

### Patch Changes

- 1be017d: Account.isMe now indicates whether an account is the currently active account. To check if an account is the owner of the local node use isLocalNodeOwner instead.

## 0.9.20

### Patch Changes

- b01cc1f: Switches from symbols to prefixes strings for private properties

## 0.9.19

### Patch Changes

- Updated dependencies [6ad0a9f]
  - cojson@0.9.19

## 0.9.18

### Patch Changes

- Updated dependencies [8898b10]
  - cojson@0.9.18

## 0.9.17

### Patch Changes

- c2ca1fe: Add cross-platform invite API
- 1227047: Improve typescript types for group.addMember

## 0.9.16

### Patch Changes

- 24b3b6a: Extract friendly user name for profile creation when authenticating using Clerk with a regular email address.
  Email passed to creationProps when using Clerk auth
  Clear stored Clerk credentials on logout

## 0.9.15

### Patch Changes

- 7491711: Testing: correctly set the globalMe before the migration when calling createJazzTestAccount

## 0.9.14

### Patch Changes

- 3df93cc: Add API to setup a test sync in the test environment

## 0.9.13

### Patch Changes

- Updated dependencies [8d29e50]
  - cojson@0.9.13

## 0.9.12

### Patch Changes

- Updated dependencies [15d4b2a]
  - cojson@0.9.12

## 0.9.11

### Patch Changes

- Updated dependencies [efbf3d8]
- Updated dependencies [5863bad]
  - cojson@0.9.11

## 0.9.10

### Patch Changes

- 5e83864: Improve error management on initial auth, fixed an infinite loop when migration fails
- Updated dependencies [4aa377d]
  - cojson@0.9.10

## 0.9.9

### Patch Changes

- 8eb9247: Add CoRichText support
- Updated dependencies [8eb9247]
  - cojson@0.9.9

## 0.9.8

### Patch Changes

- d1d773b: Make possible to call the load/subscribe/create API without passing me

## 0.9.1

### Patch Changes

- 1b71969: Add Onboarding auth to handle users onboarding without an auth screen

## 0.9.0

### Patch Changes

- 8eda792: Optimize the subscribe to resolve the CoValues stored in memory synchronously
- Updated dependencies [8eda792]
- Updated dependencies [1ef3226]
  - cojson@0.9.0

## 0.8.51

### Patch Changes

- dc62b95: Return field name on \_edits
- 1de26f8: Simplify the .create calls by accepting directly "Account | Group" as second param

## 0.8.50

### Patch Changes

- Updated dependencies [43378ef]
  - cojson@0.8.50

## 0.8.49

### Patch Changes

- Updated dependencies [25dfd90]
  - cojson@0.8.49

## 0.8.48

### Patch Changes

- 635e824: fix loading of CoMaps with an empty schema
- 0a85982: Remove the requirement of calling super.migrate when defining the account migration
- Updated dependencies [10ea733]
  - cojson@0.8.48

## 0.8.45

### Patch Changes

- fa41f8e: Add a bundle step to not expose the circular deps to the lib consumers
- 88d7d9a: Add Inbox a new experimental API to simplfy the initial handshake between accounts
- 60e35ea: Reduce the amount of circular deps
- Updated dependencies [6f0bd7f]
- Updated dependencies [fca6a0b]
- Updated dependencies [88d7d9a]
  - cojson@0.8.45

## 0.8.44

### Patch Changes

- Updated dependencies [5d20c81]
  - cojson@0.8.44

## 0.8.41

### Patch Changes

- Updated dependencies [3252502]
- Updated dependencies [6370348]
- Updated dependencies [ac216b9]
  - cojson@0.8.41

## 0.8.39

### Patch Changes

- 249eecb: Added new APIs to wait for CoValue sync
- Updated dependencies [249eecb]
- Updated dependencies [3121551]
  - cojson@0.8.39

## 0.8.38

### Patch Changes

- Updated dependencies [b00ee91]
- Updated dependencies [f488c09]
  - cojson@0.8.38

## 0.8.37

### Patch Changes

- Updated dependencies [3d9f12e]
  - cojson@0.8.37

## 0.8.36

### Patch Changes

- 441fe27: Optimise large record-like CoMaps for access of latest value
- Updated dependencies [441fe27]
  - cojson@0.8.36

## 0.8.35

### Patch Changes

- 8b87117: Implement Group Inheritance
- Updated dependencies [3f15a23]
- Updated dependencies [46f2ab8]
- Updated dependencies [8b87117]
- Updated dependencies [a6b6ccf]
  - cojson@0.8.35

## 0.8.34

### Patch Changes

- Updated dependencies [e4f110f]
  - cojson@0.8.34

## 0.8.32

### Patch Changes

- df42b2b: Allow getting all edits for a specific key in a CoMap
- Updated dependencies [df42b2b]
  - cojson@0.8.32

## 0.8.31

### Patch Changes

- Updated dependencies [e511d6d]
  - cojson@0.8.31

## 0.8.30

### Patch Changes

- Updated dependencies [0a2fae3]
- Updated dependencies [99cda2f]
  - cojson@0.8.30

## 0.8.29

### Patch Changes

- Updated dependencies [dcc9c2e]
- Updated dependencies [699553f]
  - cojson@0.8.29

## 0.8.28

### Patch Changes

- Updated dependencies [605734c]
  - cojson@0.8.28

## 0.8.27

### Patch Changes

- Updated dependencies [75fdff4]
  - cojson@0.8.27

## 0.8.23

### Patch Changes

- d348c2d: Rename BinaryCoStream to FileStream
- 6902b5b: Rename CoStream to CoFeed
- 1a0cd3d: Added SchemaUnion.Of(), a new API that lets you express unions of other Schema definitions (often different subclasses of a parent Schema class) that are correctly narrowed in TypeScript and correctly instantiated at runtime based on a discriminating field in the raw loaded CoValue.
- Updated dependencies [6f745be]
- Updated dependencies [124bf67]
  - cojson@0.8.23

## 0.8.21

### Patch Changes

- 149ca97: changed jazz-tools TS target to ES2021
- Updated dependencies [0f30eea]
  - cojson@0.8.21

## 0.8.19

### Patch Changes

- Updated dependencies [9c2aadb]
  - cojson@0.8.19

## 0.8.18

### Patch Changes

- Updated dependencies [d4319d8]
  - cojson@0.8.18

## 0.8.17

### Patch Changes

- Updated dependencies [d433cf4]
  - cojson@0.8.17

## 0.8.16

### Patch Changes

- Updated dependencies [b934fab]
  - cojson@0.8.16

## 0.8.15

### Patch Changes

- cce679b: Export `type Credentials` and mark `AuthResult.saveCredentials` as optional and run if available

## 0.8.14

### Patch Changes

- 36273b3: Cache other usages of Account.fromRaw

## 0.8.13

### Patch Changes

- fd011d7: Add a cache layer on the loadedAs account reads

## 0.8.12

### Patch Changes

- Updated dependencies [6ed75eb]
  - cojson@0.8.12

## 0.8.11

### Patch Changes

- Updated dependencies [1ed4ab5]
  - cojson@0.8.11

## 0.8.5

### Patch Changes

- c3f4e6b: Fix order of exports fields in package.json
- d9152ed: Allow interface types as generic argument in coField.json
- Updated dependencies [c3f4e6b]
- Updated dependencies [d9152ed]
  - cojson@0.8.5

## 0.8.3

### Patch Changes

- Updated dependencies
  - cojson@0.8.3

## 0.8.2

### Patch Changes

- a075f90: Fixed cursor reset when interacting with text inputs

## 0.8.1

### Patch Changes

- Expose randomSessionProvider and fix jazz-run

## 0.8.0

### Minor Changes

- bcec3be: Implement new top-level context creation and auth method API

### Patch Changes

- ad40b88: First sketch of API for creating and finding unique CoValues
- 23369dc: Re-add logout functionality to AuthMethods
- c2b62a0: Make anonymous auth work better
- 1a979b6: Implement guest auth without account
- Updated dependencies [6a147c2]
- Updated dependencies [ad40b88]
  - cojson@0.8.0

## 0.7.35-guest-auth.6

### Patch Changes

- Re-add logout functionality to AuthMethods

## 0.7.35

### Patch Changes

- 49a8b54: Fix on CoMapInit to not allow null values on required refs
- 6f80282: fix: handle null values for coField.refs
- 35bbcd9: Fix loadAsBlob resolving too early
- f350e90: Added a priority system for the sync messages
- Updated dependencies [35bbcd9]
- Updated dependencies [f350e90]
  - cojson@0.7.35

## 0.7.34

### Patch Changes

- Updated dependencies [5d91f9f]
- Updated dependencies [5094e6d]
- Updated dependencies [b09589b]
- Updated dependencies [2c3a40c]
- Updated dependencies [4e16575]
- Updated dependencies [ea882ab]
  - cojson@0.7.34

## 0.7.34-neverthrow.8

### Patch Changes

- Updated dependencies
  - cojson@0.7.34-neverthrow.8

## 0.7.34-neverthrow.7

### Patch Changes

- Updated dependencies
  - cojson@0.7.34-neverthrow.7

## 0.7.34-neverthrow.4

### Patch Changes

- Updated dependencies
  - cojson@0.7.34-neverthrow.4

## 0.7.34-neverthrow.3

### Patch Changes

- Updated dependencies
  - cojson@0.7.34-neverthrow.3

## 0.7.34-neverthrow.1

### Patch Changes

- Updated dependencies
  - cojson@0.7.34-neverthrow.1

## 0.7.34-neverthrow.0

### Patch Changes

- Updated dependencies
  - cojson@0.7.34-neverthrow.0

## 0.7.33

### Patch Changes

- Updated dependencies [b297c93]
- Updated dependencies [3bf5127]
- Updated dependencies [a8b74ff]
- Updated dependencies [db53161]
  - cojson@0.7.33

## 0.7.33-hotfixes.5

### Patch Changes

- Updated dependencies
  - cojson@0.7.33-hotfixes.5

## 0.7.33-hotfixes.4

### Patch Changes

- Updated dependencies
  - cojson@0.7.33-hotfixes.4

## 0.7.33-hotfixes.3

### Patch Changes

- Updated dependencies
  - cojson@0.7.33-hotfixes.3

## 0.7.33-hotfixes.0

### Patch Changes

- Updated dependencies
  - cojson@0.7.33-hotfixes.0

## 0.7.32

### Patch Changes

- Adapt type of applyDiff to make CoMaps fully subclassable again

## 0.7.31

### Patch Changes

- Updated dependencies
  - cojson@0.7.31

## 0.7.29

### Patch Changes

- Updated dependencies
  - cojson@0.7.29

## 0.7.28

### Patch Changes

- Updated dependencies
  - cojson@0.7.28

## 0.7.26

### Patch Changes

- Remove Effect from jazz/cojson internals
- Updated dependencies
  - cojson@0.7.26

## 0.7.25

### Patch Changes

- Implement applyDiff on CoMap to only update changed fields

## 0.7.24

### Patch Changes

- Remove effectful API for loading/subscribing

## 0.7.23

### Patch Changes

- Mostly complete OPFS implementation (single-tab only)
- Updated dependencies
  - cojson@0.7.23

## 0.7.21

### Patch Changes

- Fix another bug in CoMap 'has' proxy trap

## 0.7.20

### Patch Changes

- Fix bug in CoMap 'has' trap

## 0.7.19

### Patch Changes

- Add support for "in" operator in CoMaps

## 0.7.18

### Patch Changes

- Updated dependencies
  - cojson@0.7.18

## 0.7.17

### Patch Changes

- Updated dependencies
  - cojson@0.7.17

## 0.7.16

### Patch Changes

- Fix: allow null in encoded fields

## 0.7.14

### Patch Changes

- Use Effect Queues and Streams instead of custom queue implementation
- Updated dependencies
  - cojson@0.7.14

## 0.7.13

### Patch Changes

- Fix CoList.toJSON()

## 0.7.12

### Patch Changes

- Fix: toJSON infinitely recurses on circular CoValue structures

## 0.7.11

### Patch Changes

- Updated dependencies
  - cojson@0.7.11
  - cojson-transport-nodejs-ws@0.7.11

## 0.7.10

### Patch Changes

- Updated dependencies
  - cojson@0.7.10
  - cojson-transport-nodejs-ws@0.7.10

## 0.7.9

### Patch Changes

- Updated dependencies
  - cojson@0.7.9
  - cojson-transport-nodejs-ws@0.7.9

## 0.7.8

### Patch Changes

- Fix CoMaps not initialising properly when passing too many init options

## 0.7.6

### Patch Changes

- Provide way to create accounts as another account

## 0.7.3

### Patch Changes

- Clean up loading & subscription API

## 0.7.1

### Patch Changes

- Add runtime option for optional refs

## 0.7.0

### Minor Changes

- e299c3e: New simplified API

### Patch Changes

- 8636319: Fix infinite recursion in subscriptionScope
- 8636319: Fix type of init param for CoMap.create
- 1a35307: Implement first devtools formatters
- 96c494f: Implement profile visibility based on groups & new migration signature
- 59c18c3: CoMap fix
- 19f52b7: Fixed bug with newRandomSessionID being called before crypto was ready
- 8636319: Implement deep loading, simplify API
- 19004b4: Add .all to CoStreamEntry
- a78f168: Make Account -> Profile a lazy ref schema
- 52675c9: Fix CoList.splice / RawCoList.append
- 129e2c1: More precise imports from @effect/schema
- 1cfa279: More superclass-compatible CoMaps
- 704af7d: Add maxWidth option for loading images
- 460478f: Use effect 3.0
- 6b0418f: Fix image resolution loading
- ed5643a: Fix CoMap \_refs for co.items
- bde684f: CoValue casting & auto-subbing \_owner
- c4151fc: Support stricter TS lint rules
- 63374cc: Relax types of CoMap.\_schema
- 01ac646: Make CoMaps even more subclassable
- a5e68a4: Make refs type more precise
- 952982e: Consistent proxy based API
- 1a35307: Add ability to declare minimum required data in subscribe & Improve property access tracing
- 5fa277c: Fix CoMap.Record.toJSON()
- 60d5ca2: Introduce jazz-tools CLI
- 21771c4: Reintroduce changes from main
- 77c2b56: Get rid of self generics, new create syntax
- 63374cc: Fix schema of Account & Group
- d2e03ff: Fix variance of ID.\_\_type
- 354bdcd: Even friendlier for subclassing CoMap
- 60d5ca2: Clean up exports
- 69ac514: Use effect schema much less
- f8a5c46: Fix CoStream types
- f0f6f1b: Clean up API more & re-add jazz-nodejs
- e5eed5b: Make refs on list more precise
- 1a44f87: Refactoring
- 627d895: Get rid of Co namespace
- 1200aae: Cache CoValue proxies
- 63374cc: Make sure delete on CoMaps deletes keys
- ece35b3: Make fast-check a direct dependency to help dev time resolution
- 38d4410: CoMap fixes and improvements
- 85d2b62: More subclass-friendly types in CoMap
- fd86c11: Extract jazz cli into jazz-run package
- 52675c9: Fix Costream[...].all
- Updated dependencies [1a35307]
- Updated dependencies [96c494f]
- Updated dependencies [19f52b7]
- Updated dependencies [d8fe2b1]
- Updated dependencies [1200aae]
- Updated dependencies [52675c9]
- Updated dependencies [1a35307]
- Updated dependencies [e299c3e]
- Updated dependencies [bf0f8ec]
- Updated dependencies [c4151fc]
- Updated dependencies [8636319]
- Updated dependencies [952982e]
- Updated dependencies [21771c4]
- Updated dependencies [69ac514]
- Updated dependencies [f0f6f1b]
- Updated dependencies [1a44f87]
- Updated dependencies [627d895]
- Updated dependencies [63374cc]
- Updated dependencies [a423eee]
  - cojson@0.7.0
  - cojson-transport-nodejs-ws@0.7.0

## 0.7.0-alpha.42

### Patch Changes

- Fixed bug with newRandomSessionID being called before crypto was ready
- Updated dependencies
  - cojson@0.7.0-alpha.42
  - cojson-transport-nodejs-ws@0.7.0-alpha.42

## 0.7.0-alpha.41

### Patch Changes

- Updated dependencies
  - cojson-transport-nodejs-ws@0.7.0-alpha.41

## 0.7.0-alpha.39

### Patch Changes

- Updated dependencies
  - cojson@0.7.0-alpha.39
  - cojson-transport-nodejs-ws@0.7.0-alpha.39

## 0.7.0-alpha.38

### Patch Changes

- Fix infinite recursion in subscriptionScope
- Fix type of init param for CoMap.create
- Implement deep loading, simplify API
- Updated dependencies
  - cojson@0.7.0-alpha.38
  - cojson-transport-nodejs-ws@0.7.0-alpha.38

## 0.7.0-alpha.37

### Patch Changes

- Updated dependencies
  - cojson@0.7.0-alpha.37
  - cojson-transport-nodejs-ws@0.7.0-alpha.37

## 0.7.0-alpha.36

### Patch Changes

- 1a35307: Implement first devtools formatters
- 6b0418f: Fix image resolution loading
- 1a35307: Add ability to declare minimum required data in subscribe & Improve property access tracing
- Updated dependencies [1a35307]
- Updated dependencies [1a35307]
  - cojson@0.7.0-alpha.36
  - cojson-transport-nodejs-ws@0.7.0-alpha.36

## 0.7.0-alpha.35

### Patch Changes

- Cache CoValue proxies
- Updated dependencies
  - cojson@0.7.0-alpha.35
  - cojson-transport-nodejs-ws@0.7.0-alpha.35

## 0.7.0-alpha.34

### Patch Changes

- Extract jazz cli into jazz-run package

## 0.7.0-alpha.32

### Patch Changes

- Introduce jazz-tools CLI
- Clean up exports

## 0.7.0-alpha.31

### Patch Changes

- Get rid of self generics, new create syntax

## 0.7.0-alpha.30

### Patch Changes

- CoValue casting & auto-subbing \_owner

## 0.7.0-alpha.29

### Patch Changes

- Reintroduce changes from main
- Updated dependencies
  - cojson@0.7.0-alpha.29

## 0.7.0-alpha.28

### Patch Changes

- Implement profile visibility based on groups & new migration signature
- Updated dependencies
  - cojson@0.7.0-alpha.28

## 0.7.0-alpha.27

### Patch Changes

- Fix CoList.splice / RawCoList.append
- Fix Costream[...].all
- Updated dependencies
  - cojson@0.7.0-alpha.27

## 0.7.0-alpha.26

### Patch Changes

- Fix CoMap.Record.toJSON()

## 0.7.0-alpha.25

### Patch Changes

- Make Account -> Profile a lazy ref schema

## 0.7.0-alpha.24

### Patch Changes

- Relax types of CoMap.\_schema
- Fix schema of Account & Group
- Make sure delete on CoMaps deletes keys
- Updated dependencies
  - cojson@0.7.0-alpha.24

## 0.7.0-alpha.23

### Patch Changes

- CoMap fixes and improvements

## 0.7.0-alpha.22

### Patch Changes

- Fix CoMap \_refs for co.items

## 0.7.0-alpha.21

### Patch Changes

- Add maxWidth option for loading images

## 0.7.0-alpha.20

### Patch Changes

- Make fast-check a direct dependency to help dev time resolution

## 0.7.0-alpha.19

### Patch Changes

- More precise imports from @effect/schema

## 0.7.0-alpha.17

### Patch Changes

- Use effect 3.0

## 0.7.0-alpha.16

### Patch Changes

- Make CoMaps even more subclassable

## 0.7.0-alpha.15

### Patch Changes

- More superclass-compatible CoMaps

## 0.7.0-alpha.14

### Patch Changes

- Fix CoStream types

## 0.7.0-alpha.13

### Patch Changes

- Add .all to CoStreamEntry

## 0.7.0-alpha.12

### Patch Changes

- Fix variance of ID.\_\_type

## 0.7.0-alpha.11

### Patch Changes

- Support stricter TS lint rules
- Updated dependencies
  - cojson@0.7.0-alpha.11

## 0.7.0-alpha.10

### Patch Changes

- Clean up API more & re-add jazz-nodejs
- Updated dependencies
  - cojson@0.7.0-alpha.10

## 0.7.0-alpha.9

### Patch Changes

- Even friendlier for subclassing CoMap

## 0.7.0-alpha.8

### Patch Changes

- More subclass-friendly types in CoMap

## 0.7.0-alpha.7

### Patch Changes

- Consistent proxy based API
- Updated dependencies
  - cojson@0.7.0-alpha.7

## 0.7.0-alpha.6

### Patch Changes

- CoMap fix

## 0.7.0-alpha.5

### Patch Changes

- Refactoring
- Updated dependencies
  - cojson@0.7.0-alpha.5

## 0.7.0-alpha.4

### Patch Changes

- Make refs on list more precise

## 0.7.0-alpha.3

### Patch Changes

- Make refs type more precise

## 0.7.0-alpha.2

### Patch Changes

- Get rid of Co namespace

## 0.7.0-alpha.1

### Patch Changes

- Use effect schema much less
- Updated dependencies
  - cojson@0.7.0-alpha.1

## 0.7.0-alpha.0

### Minor Changes

- New simplified API

### Patch Changes

- Updated dependencies
  - cojson@0.7.0-alpha.0

## 0.6.1

### Patch Changes

- Fix loading of accounts
- Updated dependencies
  - cojson@0.6.5

## 0.6.0

### Minor Changes

- Make addMember and removeMember take loaded Accounts instead of just IDs

### Patch Changes

- Updated dependencies
  - cojson@0.6.0

## 0.5.0

### Minor Changes

- Adding a lot of performance improvements to cojson, add a stresstest for the twit example and make that run smoother in a lot of ways.

### Patch Changes

- Updated dependencies
  - cojson@0.5.0
