import type { KvStore } from "jazz-tools/react-native-core";
import { createMMKV } from "react-native-mmkv";

const storage = createMMKV({
  id: "jazz-react-native.default",
});

export class MMKVStore implements KvStore {
  async get(key: string): Promise<string | null> {
    return storage.getString(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    storage.set(key, value);
  }

  async delete(key: string): Promise<void> {
    // v4 renamed `delete` to `remove`, and it returns a boolean we don't need.
    storage.remove(key);
  }

  async clearAll(): Promise<void> {
    storage.clearAll();
  }
}
