# cojson-core-wasm

## 0.20.20

## 0.20.19

## 0.20.18

## 0.20.17

## 0.20.16

## 0.20.15

### Patch Changes

- 2d5cb0b: Surface WASM panics as JavaScript errors and ship the generated inline snippet
  bundle.

## 0.20.14

## 0.20.13

## 0.20.12

## 0.20.11

## 0.20.10

### Patch Changes

- 706ab57: Added optional restricted deletion mode for CoList values, allowing only manager/admin roles to perform deletions when enabled via schema permissions: `co.list().withPermission({writer: "appendOnly"})`

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

## 0.19.13

## 0.19.12

## 0.19.11

## 0.19.10

## 0.19.9

## 0.19.8

## 0.19.7

## 0.19.6

## 0.19.5

## 0.19.4

## 0.19.3

## 0.19.2

## 0.19.1

## 0.19.0

## 0.18.38

## 0.18.37

## 0.18.36

## 0.18.35

## 0.18.34

## 0.18.33

## 0.18.32

## 0.18.31

## 0.18.30

## 0.18.29

## 0.18.28

## 0.18.27

## 0.18.26

## 0.18.25

## 0.18.24

## 0.18.23

## 0.18.22

### Patch Changes

- 1e20db6: Added cojson-core-napi

## 0.18.21

## 0.18.20

## 0.18.19

## 0.18.18

## 0.18.17

## 0.18.16

### Patch Changes

- 629c275: Missing `edge-lite.js` script in pkg

## 0.18.15

### Patch Changes

- a584ab3: Add WasmCrypto support for Cloudflare Workers and edge runtimes by importing `jazz-tools/load-edge-wasm`.
  - Enable WasmCrypto functionality by initializing the WebAssembly environment with the import: `import "jazz-tools/load-edge-wasm"` in edge runtimes.
  - Guarantee compatibility across Cloudflare Workers and other edge runtime environments.

## 0.18.14

## 0.18.13

## 0.18.12

## 0.18.11

## 0.18.10

## 0.18.9

## 0.18.8

## 0.18.7

## 0.18.6

## 0.18.5

## 0.18.4

### Patch Changes

- e5283c2: Directly load the WASM module data to avoid issues with envs where Response is overwritten

## 0.18.3

## 0.18.2

## 0.18.1

## 0.18.0

## 0.17.14

## 0.17.13

## 0.17.12

## 0.17.11

## 0.17.10
