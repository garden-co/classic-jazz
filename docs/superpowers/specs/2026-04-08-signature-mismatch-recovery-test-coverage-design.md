# Signature Mismatch Recovery Test Coverage Design

Date: 2026-04-08
Owner: Codex brainstorming pass
Status: Ready for user review

## Summary

Expand signature mismatch recovery coverage using a layered test strategy:

- keep realistic end-to-end crash and reconnection scenarios in [packages/cojson/src/tests/sync.signatureMismatchRecovery.test.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/tests/sync.signatureMismatchRecovery.test.ts)
- add focused invariant tests for session rewrite and tombstone behavior near [packages/cojson/src/coValueCore/coValueCore.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/coValueCore/coValueCore.ts) and [packages/cojson/src/coValueCore/verifiedState.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/coValueCore/verifiedState.ts)
- add focused async durability and queue-ordering tests near [packages/cojson/src/storage/storageAsync.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/storage/storageAsync.ts) and [packages/cojson/src/queue/StoreQueue.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/queue/StoreQueue.ts)

Every new test should be understandable from the test body alone. To make that practical, each test should use realistic fixtures and begin with a short ASCII graph that shows topology, pre-recovery state, and the expected repaired state.

## Context

The current recovery tests cover the basic divergent-session flow:

- the server detects a signature mismatch
- the recovering client replaces one session with authoritative server content
- divergent local edits are preserved via a conflict session

That baseline is useful, but it undersamples the specific failure surfaces in the current design:

1. Async durability ordering in [packages/cojson/src/storage/storageAsync.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/storage/storageAsync.ts)
   `replaceSessionHistory` can be queued behind other work, and recovery must not rebuild memory before the durable rewrite is complete.
2. Corrective replication after session rewrite in [packages/cojson/src/coValueCore/coValueCore.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/coValueCore/coValueCore.ts)
   A session rewrite is not append-only. Peers that already accepted the stale session need corrective convergence coverage.
3. Deleted/tombstone semantics in [packages/cojson/src/coValueCore/verifiedState.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/coValueCore/verifiedState.ts)
   A rebuilt state that still contains a delete session must serialize as deleted, not as historical full history.

Recent churn in storage loading and reconciliation also makes this an active area of the codebase. The design should therefore optimize for diagnosis, not only detection.

## Goals

- Catch correctness regressions in signature mismatch recovery before production.
- Cover both user-visible recovery behavior and internal invariants that integration timing alone may miss.
- Make failures easy to interpret by using realistic actors, realistic data, and explicit scenario diagrams.
- Allow intentionally failing tests when they reveal design gaps in the current implementation.

## Non-Goals

- Exhaustively permute every possible timing race in a single integration file.
- Hide complex scenarios behind large opaque test builders.
- Refactor the recovery implementation as part of this design phase.

## Recommended Test Strategy

Use a layered suite.

### Layer 1: end-to-end recovery stories

Primary file:

- [packages/cojson/src/tests/sync.signatureMismatchRecovery.test.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/tests/sync.signatureMismatchRecovery.test.ts)

Purpose:

- model crashes, restarts, reconnects, replication to other peers, and fresh loads
- validate the externally observable repaired state
- keep the tests close to production behavior with real nodes, real storage, and real sync

### Layer 2: recovery invariants near the core

New focused file:

- [packages/cojson/src/tests/coValueCore.signatureMismatchRecovery.test.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/tests/coValueCore.signatureMismatchRecovery.test.ts)

Purpose:

- test `replaceSessionContent()` directly
- test `newContentSince()` after rebuild
- verify delete-session and tombstone serialization behavior
- verify authoritative multi-piece session replacement without relying on network timing

### Layer 3: async durability and queue ordering

New focused file:

- [packages/cojson/src/tests/storageAsync.replaceSessionHistory.test.ts](/Users/guidodorsi/workspace/jazz/packages/cojson/src/tests/storageAsync.replaceSessionHistory.test.ts)

Purpose:

- verify queue semantics around `replaceSessionHistory`
- verify recovery sequencing when the store queue is already busy
- isolate persistence-order bugs without needing a multi-peer sync story

## Realistic Fixtures

All new recovery tests should use the same actor names:

- `alice`: recovering client that crashes and reconnects
- `jazzCloud`: authoritative server
- `bob`: subscribed collaborator who may already have seen stale history
- `charlie`: fresh loader after recovery, used to detect serialized-history leaks

All map-based scenarios should use a realistic shared task fixture instead of anonymous keys:

- `title`
- `status`
- `assignee`
- `priority`
- `archived`

This keeps the scenario understandable when reading the graph and the assertions together.

Recommended helper layer:

- `setupRecoveryActors()`
- `createSharedTaskMap()`
- `crashAfterServerAckBeforeLocalPersist()`
- `restartAliceFromDisk()`
- `connectBobSubscriber()`
- `loadCharlieFresh()`
- `expectTaskFields()`
- `delayStorageReplacement()` or equivalent narrow storage hook

Helpers should stay small and explicit. The test body should still read as a narrative.

## Required Test Documentation Format

Every new test should start with a short docblock using the same three sections:

- `Topology`
- `Before reconnect`
- `Expected after recovery`

Example:

```ts
/**
 * Alice crashed after Jazz Cloud accepted `status="review"`
 * but before Alice persisted it locally.
 *
 * Topology
 *   Alice --------> Jazz Cloud --------> Bob
 *     ^                                 |
 *     |------------- reconnect ---------|
 *
 * Before reconnect
 *   Alice disk   : title, priority
 *   Alice memory : title, priority, assignee, archived
 *   Jazz Cloud   : title, priority, status
 *   Bob          : title, priority, status
 *
 * Expected after recovery
 *   rewritten session : title, priority, status
 *   conflict session  : assignee, archived
 *   visible map       : title, priority, status, assignee, archived
 */
```

The graph format should be consistent across the suite so failures are easy to scan.

## Scenario Matrix

### Integration stories in sync.signatureMismatchRecovery.test.ts

1. `repairs alice after crash and preserves divergent task edits`
   Baseline story using realistic task fields and standard graph formatting.

2. `repairs alice when jazzCloud is ahead by more transactions than alice`
   Covers the case where the authoritative branch is longer, not only the case where the client is longer.

3. `repairs alice across common prefix lengths of 0, 1, and many`
   Covers prefix math around the first divergent transaction.

4. `replays authoritative replacement when the repaired session arrives in multiple pieces`
   Exercises `SessionNewContent[]` replay instead of assuming a single replacement chunk.

5. `repairs alice when there are no divergent local edits to preserve`
   Ensures rewrite-only recovery does not invent a conflict session.

6. `repairs alice while preserving other local sessions that did not mismatch`
   Ensures recovery is scoped to the rewritten session rather than collapsing unrelated local state.

7. `bob converges after already observing alice's stale session before recovery`
   Covers corrective replication to an already-subscribed collaborator.

8. `fresh charlie load after alice recovery sees only repaired history`
   Detects cases where Alice memory looks correct but the replicated serialized state still leaks stale history.

9. `deleted task recovery stays tombstone-only for charlie and future sync`
   Covers deleted-value recovery end to end.

10. `two coValues recover concurrently without cross-value queue corruption`
    Covers shared queue/global ordering effects at a realistic level.

### Focused core tests in coValueCore.signatureMismatchRecovery.test.ts

1. `replaceSessionContent rewrites only the targeted session`
2. `replaceSessionContent preserves unrelated sessions exactly`
3. `replaceSessionContent accepts authoritative multi-piece session content`
4. `replaceSessionContent with no divergent local edits does not create extra serialized content`
5. `recovered deleted state marks the rebuilt value as deleted for serialization`
6. `newContentSince after deleted recovery emits tombstone-only content`

These tests should directly assert `core.isDeleted`, serialized content shape, and session membership after rebuild.

### Focused storage tests in storageAsync.replaceSessionHistory.test.ts

1. `replaceSessionHistory waits behind in-flight store work before recovery continues`
2. `queued session replacement does not resolve early when processQueue is already active`
3. `back-to-back replacements for the same coValue preserve final durable order`
4. `replacements for different coValues do not break global queue sequencing`
5. `restart after queued but unfinished replacement does not resurrect stale session history`

These tests should assert both in-memory timing and storage-visible state where possible.

## Expected Red Tests

The suite should include intentionally failing tests where the current implementation does not yet satisfy the desired behavior.

Priority red scenarios:

- recovery resumes memory rebuild before queued async replacement is durably stored
- bob retains stale original-session history after alice recovery because the repair path only syncs append-only deltas
- deleted recovery serializes historical non-delete sessions to fresh peers instead of a tombstone-only state

If CI needs a temporary escape hatch, use `test.fails(...)` with a short comment naming the known design gap. The preferred shape is still a normal test that fails loudly until the design is fixed.

## Acceptance Criteria

Every recovery test added under this design should satisfy the following:

1. It uses realistic actors and realistic task-map fields.
2. It begins with the standard ASCII graph docblock.
3. It asserts the recovering node's visible state after repair.
4. Integration tests also assert either a collaborator view, a fresh-loader view, or both.
5. Durability tests assert storage outcomes, not only memory outcomes.
6. Deleted-value tests assert both deletion flags and serialized tombstone behavior.
7. Failing design-gap cases are kept as explicit tests rather than TODO comments.

## Naming Conventions

Test names should read like short incident reports, for example:

- `repairs alice after crash and preserves bob convergence`
- `does not resurrect task history when recovered value is deleted`
- `waits for queued async session replacement before rebuilding memory`

Avoid generic data names like `a`, `b`, `c`, `d` for new scenarios. The test output should be interpretable without opening the recovery implementation.

## Risks and Trade-Offs

- More end-to-end tests will cost runtime, so the integration file should carry only the highest-signal stories.
- Focused core and storage tests may assert behavior that current production flows do not yet guarantee. That is acceptable because the purpose is to surface design gaps early.
- Overusing helpers can make scenarios opaque. Helpers should reduce repetition but not hide the story.

## Implementation Outline

1. Refactor the existing integration file to use realistic task fixtures and graph docblocks.
2. Add the missing end-to-end scenarios in `sync.signatureMismatchRecovery.test.ts`.
3. Add a focused core recovery test file for session-rewrite and tombstone invariants.
4. Add a focused async storage test file for queue ordering and durability sequencing.
5. Mark current design-gap cases as expected failures only if needed to preserve short-term CI.

## Review Checklist

- Does each scenario map to a concrete production surprise we want to avoid?
- Will a failing test make the topology and broken invariant obvious from the test name and graph alone?
- Are deleted/tombstone semantics asserted at both the core and integration layers?
- Are we testing durability ordering separately from replication correction?
- Is the integration file still readable after the new scenarios are added?
