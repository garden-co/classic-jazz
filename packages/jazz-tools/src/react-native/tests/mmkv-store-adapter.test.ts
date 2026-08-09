import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins the react-native-mmkv v4 API (factory + `remove`). If a future major
// renames these, this mock's shape stops matching and CI fails here instead of
// at app launch, which is where the v3 `new MMKV()`/`delete()` breakage lands.
const { store, createMMKV } = vi.hoisted(() => {
  const store = {
    getString: vi.fn<(key: string) => string | undefined>(),
    set: vi.fn(),
    remove: vi.fn(),
    clearAll: vi.fn(),
  };
  return { store, createMMKV: vi.fn(() => store) };
});

vi.mock("react-native-mmkv", () => ({ createMMKV }));

import { MMKVStore } from "../storage/mmkv-store-adapter.js";

describe("MMKVStore", () => {
  // Don't clear createMMKV — it records its only call at module load.
  beforeEach(() => {
    Object.values(store).forEach((fn) => fn.mockReset());
  });

  it("creates the store with the stable jazz id", () => {
    // new MMKVStore() is unnecessary — createMMKV runs at module load
    expect(createMMKV).toHaveBeenCalledWith({
      id: "jazz-react-native.default",
    });
  });

  it("routes delete() to remove() (renamed in v4)", async () => {
    await new MMKVStore().delete("k");
    expect(store.remove).toHaveBeenCalledWith("k");
  });

  it("get() returns null for a missing key", async () => {
    store.getString.mockReturnValueOnce(undefined);
    expect(await new MMKVStore().get("k")).toBeNull();
  });

  it("get() returns the stored string", async () => {
    store.getString.mockReturnValueOnce("v");
    expect(await new MMKVStore().get("k")).toBe("v");
  });
});
