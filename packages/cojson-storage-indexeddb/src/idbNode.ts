import { StorageApiAsync } from "cojson";
import { IDBClient } from "./idbClient.js";
import { IDBConnectionManager } from "./IDBConnectionManager.js";

let DATABASE_NAME = "jazz-storage";

export function internal_setDatabaseName(name: string) {
  DATABASE_NAME = name;
}

export async function getIndexedDBStorage(name = DATABASE_NAME) {
  const dbManager = new IDBConnectionManager(name);

  // Open eagerly so migrations run and open errors surface at startup
  await dbManager.getDb();

  return new StorageApiAsync(new IDBClient(dbManager));
}
