# Requirements: Conflicting Session Logs Recovery

## Introduction

CoValue sessions in Jazz maintain cryptographic signatures that chain transactions together. When multiple instances of an application (or tabs/processes) reuse the same session ID due to locking issues, they can create conflicting session logs. This manifests as signature verification failures when clients send updates to the sync server, as the server's version of the session log doesn't match the client's version.

The current locking mechanism in `createBrowserContext.ts` locks on `accountID + index` rather than the explicit session ID, which can lead to session ID reuse across different processes or after data loss scenarios (e.g., Electron storage issues). When this happens, transactions created by one instance may conflict with those from another instance that believes it owns the same session ID.

This specification defines the requirements for detecting and recovering from conflicting session logs while preventing data loss and maintaining security guarantees.

## User Stories and Acceptance Criteria

### US-1: Detect Session Log Conflicts

**As a** sync server  
**I want to** detect when a client sends transactions with invalid signatures due to session log conflicts  
**So that** I can initiate recovery instead of rejecting the updates

**Acceptance Criteria:**
- WHEN a client sends new content with transactions for a session
- AND the signature verification fails for that session
- AND the session belongs to the account that owns it
- THEN the sync server detects this as a session log conflict
- AND the sync server sends a content correction message to the client

### US-2: Verify Server Correction Authenticity

**As a** client  
**I want to** verify that a content correction from the server is authentic  
**So that** I don't accept malicious corrections that could compromise data integrity

**Acceptance Criteria:**
- WHEN the client receives a content correction message from the sync server
- THEN the client verifies that the correction has a valid signature
- AND if the signature is invalid, the correction is rejected
- AND if the signature is valid, the correction is accepted

### US-3: Remove Conflicting Session

**As a** client  
**I want to** remove my local conflicting session when it conflicts with the server's version  
**So that** I can continue working while maintaining session integrity

**Acceptance Criteria:**
- WHEN the client receives a valid content correction for a conflicting session
- AND the client verifies the correction signature is valid
- AND the client is the owner of the session
- THEN the client removes the conflicting local session
- AND the client applies the server's session log state
- AND the client creates a new session with a new session ID for future transactions

### US-4: Propagate Session Removal to Storage

**As a** storage system  
**I want to** properly handle session removal when corrections are applied  
**So that** the session state is correctly persisted and loaded

**Acceptance Criteria:**
- WHEN a client applies a content correction that results in session removal
- THEN the storage system removes the conflicting session log state
- AND the storage system stores the corrected session log from the server
- AND future loads of the coValue reflect the corrected session state
