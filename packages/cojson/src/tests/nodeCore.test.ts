import { beforeAll, describe, expect, test } from "vitest";
import { NapiCrypto } from "../crypto/NapiCrypto.js";
import { WasmCrypto } from "../crypto/WasmCrypto.js";
import type { CryptoProvider, NodeCoreImpl } from "../crypto/crypto.js";

// RNCrypto now has a native NodeCore adapter (RNNodeCoreAdapter, mirroring
// NapiNodeCoreAdapter's casing bridge) — see Part B of the cleanup-phase
// plan. It can't be added to nodeCoreSuite here: `RNCrypto.create()` loads
// `cojson-core-rn`'s generated bindings, which register a React Native
// TurboModule (`NativeCojsonCoreRn` via `TurboModuleRegistry.getEnforcing`)
// at import time — that requires the RN runtime and cannot be instantiated
// under vitest/node. RN NodeCore capability is exercised by CI/e2e only
// (rn-build-reusable + the Maestro e2e run); `tsc --noEmit` covers
// RNNodeCoreAdapter's `NodeCoreImpl` conformance in the meantime. All
// providers now back `createNodeCore()` with a native NodeCore adapter (the
// TS shim is gone), so the validation surface is required on every arm.
let crypto: CryptoProvider;
let wasmCrypto: CryptoProvider;

beforeAll(async () => {
  crypto = await NapiCrypto.create();
  wasmCrypto = await WasmCrypto.create();
});

// Build a real header + coId the way VerifiedState does, so createCoValue
// passes native header validation.
function makeHeaderAndId(cryptoProvider: CryptoProvider = crypto) {
  const header = {
    type: "comap" as const,
    ruleset: { type: "unsafeAllowAll" as const },
    meta: null,
    createdAt: null,
    uniqueness: "test-uniqueness",
  };
  const coId = `co_z${cryptoProvider.shortHash(header).slice("shortHash_z".length)}`;
  return { coId, headerJson: JSON.stringify(header) };
}

function nodeCoreSuite(
  name: string,
  makeNodeCore: () => NodeCoreImpl,
  getCryptoProvider: () => CryptoProvider = () => crypto,
) {
  describe(name, () => {
    test("createCoValue / hasCoValue / removeCoValue roundtrip", () => {
      const nodeCore = makeNodeCore();
      const { coId, headerJson } = makeHeaderAndId(getCryptoProvider());

      expect(nodeCore.hasCoValue(coId)).toBe(false);
      expect(nodeCore.coValueCount()).toBe(0);

      nodeCore.createCoValue(coId, headerJson);
      expect(nodeCore.hasCoValue(coId)).toBe(true);
      expect(nodeCore.coValueCount()).toBe(1);
      expect(JSON.parse(nodeCore.getHeader(coId))).toMatchObject({
        type: "comap",
      });

      nodeCore.removeCoValue(coId);
      expect(nodeCore.hasCoValue(coId)).toBe(false);
      expect(nodeCore.coValueCount()).toBe(0);
      // double remove is a no-op
      nodeCore.removeCoValue(coId);
    });

    test("unknown coId throws with Unknown CoValue message", () => {
      const nodeCore = makeNodeCore();
      expect(() => nodeCore.getHeader("co_zNope")).toThrow(
        /Unknown CoValue: co_zNope/,
      );
      expect(() => nodeCore.getSessionIds("co_zNope")).toThrow(
        /Unknown CoValue/,
      );
    });

    test("delegates session queries to the underlying registry", () => {
      const nodeCore = makeNodeCore();
      const { coId, headerJson } = makeHeaderAndId(getCryptoProvider());
      nodeCore.createCoValue(coId, headerJson);
      expect(nodeCore.getSessionIds(coId)).toEqual([]);
      expect(
        nodeCore.getTransactionCount(coId, "co_zAnybody_session_z123"),
      ).toBe(-1);
      expect(nodeCore.getKnownState(coId)).toMatchObject({
        id: coId,
        header: true,
        sessions: {},
      });
    });

    test("validateTransactions/resetValidation/roleOf are present", () => {
      const nodeCore = makeNodeCore();

      expect(typeof nodeCore.validateTransactions).toBe("function");
      expect(typeof nodeCore.resetValidation).toBe("function");
      expect(typeof nodeCore.roleOf).toBe("function");
      expect(() => nodeCore.validateTransactions("co_zNope", [])).toThrow(
        /Unknown CoValue/,
      );
      expect(() => nodeCore.roleOf("co_zNope", "someone")).toThrow(
        /Unknown CoValue/,
      );
      // resetValidation on an unregistered coId is a no-op, not an error.
      expect(() => nodeCore.resetValidation("co_zNope")).not.toThrow();
    });
  });
}

nodeCoreSuite("NapiNodeCore (native)", () => crypto.createNodeCore());
nodeCoreSuite(
  "WasmNodeCore (native)",
  () => wasmCrypto.createNodeCore(),
  () => wasmCrypto,
);

test("NapiCrypto.createNodeCore returns the native adapter", () => {
  expect(crypto.createNodeCore().constructor.name).toBe("NapiNodeCoreAdapter");
});

test("WasmCrypto.createNodeCore returns the native adapter", () => {
  expect(wasmCrypto.createNodeCore().constructor.name).toBe(
    "WasmNodeCoreAdapter",
  );
});
