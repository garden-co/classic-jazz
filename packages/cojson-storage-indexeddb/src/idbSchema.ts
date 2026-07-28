export const DATABASE_VERSION = 7;

export function openDatabase(name: string, version?: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onerror = () => {
      reject(request.error);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onupgradeneeded = (ev) => {
      const db = request.result;
      if (ev.oldVersion === 0) {
        const coValues = db.createObjectStore("coValues", {
          autoIncrement: true,
          keyPath: "rowID",
        });

        coValues.createIndex("coValuesById", "id", {
          unique: true,
        });

        const sessions = db.createObjectStore("sessions", {
          autoIncrement: true,
          keyPath: "rowID",
        });

        sessions.createIndex("sessionsByCoValue", "coValue");
        sessions.createIndex("uniqueSessions", ["coValue", "sessionID"], {
          unique: true,
        });

        db.createObjectStore("transactions", {
          keyPath: ["ses", "idx"],
        });
      }
      if (ev.oldVersion <= 1) {
        db.createObjectStore("signatureAfter", {
          keyPath: ["ses", "idx"],
        });
      }
      if (ev.oldVersion <= 4) {
        const unsyncedCoValues = db.createObjectStore("unsyncedCoValues", {
          autoIncrement: true,
          keyPath: "rowID",
        });
        unsyncedCoValues.createIndex("byCoValueId", "coValueId");
        unsyncedCoValues.createIndex(
          "uniqueUnsyncedCoValues",
          ["coValueId", "peerId"],
          {
            unique: true,
          },
        );
      }
      if (ev.oldVersion <= 5) {
        const deletedCoValues = db.createObjectStore("deletedCoValues", {
          keyPath: "coValueID",
        });
        deletedCoValues.createIndex("deletedCoValuesByStatus", "status", {
          unique: false,
        });
      }
      if (ev.oldVersion <= 6) {
        db.createObjectStore("storageReconciliationLocks", {
          keyPath: "key",
        });
      }
    };
  });
}
