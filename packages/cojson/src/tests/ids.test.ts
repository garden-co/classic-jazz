import { describe, expect, test } from "vitest";
import {
  type ActiveSessionID,
  type SessionID,
  isConflictSessionID,
  toConflictSessionID,
} from "../ids.js";

describe("conflict session IDs", () => {
  test("toConflictSessionID appends ! to active session ID", () => {
    const sessionID = "co_z123_session_zABC" as ActiveSessionID;
    const conflictID = toConflictSessionID(sessionID);
    expect(conflictID).toBe("co_z123_session_zABC!");
  });

  test("isConflictSessionID returns true for conflict sessions", () => {
    expect(isConflictSessionID("co_z123_session_zABC!" as SessionID)).toBe(
      true,
    );
  });

  test("isConflictSessionID returns false for normal sessions", () => {
    expect(isConflictSessionID("co_z123_session_zABC" as SessionID)).toBe(
      false,
    );
  });

  test("isConflictSessionID returns false for delete sessions", () => {
    expect(isConflictSessionID("co_z123_session_dABC$" as SessionID)).toBe(
      false,
    );
  });
});
