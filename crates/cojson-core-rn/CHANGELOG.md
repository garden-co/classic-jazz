# cojson-core-rn

## 0.20.20

## 0.20.19

## 0.20.18

## 0.20.17

## 0.20.16

## 0.20.15

## 0.20.14

## 0.20.13

## 0.20.12

### Patch Changes

- debcb49: Add x86_64 iOS simulator support to the `cojson-core-rn` XCFramework build configuration.

## 0.20.11

## 0.20.10

## 0.20.9

## 0.20.8

## 0.20.7

## 0.20.6

## 0.20.5

## 0.20.4

## 0.20.3

## 0.20.2

## 0.20.1

## 0.20.0

### Minor Changes

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

- 89332d5: Moved stable JSON serialization from JavaScript to Rust in SessionLog operations

  ### Changes
  - **`tryAdd`**: Stable serialization now happens in Rust. The Rust layer parses each transaction and re-serializes it to ensure a stable JSON representation for signature verification. JavaScript side now uses `JSON.stringify` instead of `stableStringify`.

  - **`addNewPrivateTransaction`** and **`addNewTrustingTransaction`**: Removed `stableStringify` usage since the data is either encrypted (private) or already in string format (trusting), making stable serialization unnecessary on the JS side.

## 0.19.22

## 0.19.19

## 0.19.18

## 0.19.17

## 0.19.16

## 0.19.15

## 0.19.14

### Patch Changes

- 41d4c52: Enabled flexible page-size support for Android builds, enabling support for 16KB page sizes to ensure compatibility with upcoming Android hardware and Google Play requirements for cojson-core-rn.

## 0.19.13

## 0.19.12

## 0.19.11

## 0.19.10

### Patch Changes

- 4f5a5e7: Version bump to align the fixed version

## 0.1.1

### Patch Changes

- d901caa: Added cojson-core-rn that improves ReactNative crypto performance
