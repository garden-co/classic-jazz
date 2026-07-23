# jazz-sveltekit

## 0.0.63

### Patch Changes

- Updated dependencies [ea0ca5c]
- Updated dependencies [9385ad4]
  - jazz-tools@0.20.20

## 0.0.62

### Patch Changes

- Updated dependencies [b13e956]
- Updated dependencies [dc43d1d]
  - jazz-tools@0.20.19

## 0.0.61

### Patch Changes

- Updated dependencies [ab2e90b]
- Updated dependencies [12b27e1]
- Updated dependencies [1c6e9ff]
- Updated dependencies [ab2e90b]
  - jazz-tools@0.20.18

## 0.0.60

### Patch Changes

- Updated dependencies [d26dccc]
- Updated dependencies [6572f1f]
- Updated dependencies [754df86]
  - jazz-tools@0.20.17

## 0.0.59

### Patch Changes

- Updated dependencies [f45aca2]
  - jazz-tools@0.20.16

## 0.0.58

### Patch Changes

- Updated dependencies [05b28a9]
- Updated dependencies [53bd0c4]
- Updated dependencies [109afa7]
  - jazz-tools@0.20.15

## 0.0.57

### Patch Changes

- jazz-tools@0.20.14

## 0.0.56

### Patch Changes

- Updated dependencies [307b11d]
- Updated dependencies [1acba7b]
- Updated dependencies [53c2cc2]
  - jazz-tools@0.20.13

## 0.0.55

### Patch Changes

- Updated dependencies [9a43096]
  - jazz-tools@0.20.12

## 0.0.54

### Patch Changes

- Updated dependencies [191ce7a]
  - jazz-tools@0.20.11

## 0.0.53

### Patch Changes

- Updated dependencies [706ab57]
- Updated dependencies [01c3641]
- Updated dependencies [796c65b]
- Updated dependencies [81c3a0a]
- Updated dependencies [cdcdad1]
- Updated dependencies [1317e90]
- Updated dependencies [76c6229]
- Updated dependencies [e707d3c]
  - jazz-tools@0.20.10

## 0.0.52

### Patch Changes

- Updated dependencies [75ecd19]
  - jazz-tools@0.20.9

## 0.0.51

### Patch Changes

- Updated dependencies [8688239]
- Updated dependencies [fc4163a]
- Updated dependencies [c7be307]
- Updated dependencies [739ea48]
- Updated dependencies [b38a526]
- Updated dependencies [f701fd7]
- Updated dependencies [0fa9e15]
  - jazz-tools@0.20.8

## 0.0.50

### Patch Changes

- jazz-tools@0.20.7

## 0.0.49

### Patch Changes

- jazz-tools@0.20.6

## 0.0.48

### Patch Changes

- Updated dependencies [23a5d7c]
- Updated dependencies [0b95532]
  - jazz-tools@0.20.5

## 0.0.47

### Patch Changes

- Updated dependencies [0c749d9]
  - jazz-tools@0.20.4

## 0.0.46

### Patch Changes

- jazz-tools@0.20.3

## 0.0.45

### Patch Changes

- Updated dependencies [2df568f]
  - jazz-tools@0.20.2

## 0.0.44

### Patch Changes

- Updated dependencies [ca306c0]
- Updated dependencies [d7f9cba]
  - jazz-tools@0.20.1

## 0.0.43

### Patch Changes

- Updated dependencies [6b9368a]
- Updated dependencies [ee19292]
- Updated dependencies [8934d8a]
  - jazz-tools@0.20.0

## 0.0.42

### Patch Changes

- Updated dependencies [89d8798]
- Updated dependencies [30b5339]
  - jazz-tools@0.19.22

## 0.0.39

### Patch Changes

- Updated dependencies [171e1c6]
- Updated dependencies [053a283]
- Updated dependencies [41b2cf4]
- Updated dependencies [923bc8e]
- Updated dependencies [83f84ca]
  - jazz-tools@0.19.19

## 0.0.38

### Patch Changes

- Updated dependencies [729d46c]
  - jazz-tools@0.19.18

## 0.0.37

### Patch Changes

- Updated dependencies [d46cffd]
  - jazz-tools@0.19.17

## 0.0.36

### Patch Changes

- Updated dependencies [25268bf]
  - jazz-tools@0.19.16

## 0.0.35

### Patch Changes

- Updated dependencies [94012a1]
- Updated dependencies [86f9676]
- Updated dependencies [b27dbc2]
  - jazz-tools@0.19.15

## 0.0.34

### Patch Changes

- jazz-tools@0.19.14

## 0.0.33

### Patch Changes

- Updated dependencies [bef1cc6]
- Updated dependencies [b839147]
  - jazz-tools@0.19.13

## 0.0.32

### Patch Changes

- Updated dependencies [9ca9e72]
- Updated dependencies [5b0bb7d]
- Updated dependencies [fa0759b]
- Updated dependencies [a2372db]
  - jazz-tools@0.19.12

## 0.0.31

### Patch Changes

- Updated dependencies [68acca4]
- Updated dependencies [c00a454]
  - jazz-tools@0.19.11

## 0.0.30

### Patch Changes

- jazz-tools@0.19.10

## 0.0.29

### Patch Changes

- Updated dependencies [d901caa]
- Updated dependencies [a2bb9f0]
  - jazz-tools@0.19.9

## 0.0.28

### Patch Changes

- Updated dependencies [21f7d34]
- Updated dependencies [b22ad89]
- Updated dependencies [28b23dd]
  - jazz-tools@0.19.8

## 0.0.27

### Patch Changes

- Updated dependencies [e113a79]
  - jazz-tools@0.19.7

## 0.0.26

### Patch Changes

- Updated dependencies [23782f0]
- Updated dependencies [56d74e4]
- Updated dependencies [bc9120b]
  - jazz-tools@0.19.6

## 0.0.25

### Patch Changes

- jazz-tools@0.19.5

## 0.0.24

### Patch Changes

- Updated dependencies [78dfffd]
- Updated dependencies [de2f8b5]
- Updated dependencies [763977a]
- Updated dependencies [e02e14c]
- Updated dependencies [3aaba61]
  - jazz-tools@0.19.4

## 0.0.23

### Patch Changes

- Updated dependencies [cddbfdb]
- Updated dependencies [114e4ce]
  - jazz-tools@0.19.3

## 0.0.22

### Patch Changes

- Updated dependencies [ef24afb]
- Updated dependencies [5f2b34b]
  - jazz-tools@0.19.2

## 0.0.21

### Patch Changes

- Updated dependencies [f444bd9]
  - jazz-tools@0.19.1

## 0.0.20

### Patch Changes

- 26386d9: Add explicit CoValue loading states:
  - Add `$isLoaded` field to discriminate between loaded and unloaded CoValues
  - Add `$jazz.loadingState` field to provide additional info about the loading state
  - All methods and functions that load CoValues now return a `MaybeLoaded<CoValue>` instead of `CoValue | null | undefined`
  - Rename `$onError: null` to `$onError: "catch"`
  - Split the `useAccount` hook into three separate hooks:
    - `useAccount`: now only returns an Account CoValue
    - `useLogOut`: returns a function for logging out of the current account
    - `useAgent`: returns the current agent
  - Add a `select` option (and an optional `equalityFn`) to `useAccount` and `useCoState`, and remove `useAccountWithSelector` and `useCoStateWithSelector`.
  - Allow specifying resolve queries at the schema level. Those queries will be used when loading CoValues, if no other resolve query is provided.
- Updated dependencies [26386d9]
  - jazz-tools@0.19.0

## 0.0.19

### Patch Changes

- Updated dependencies [349ca48]
  - jazz-tools@0.18.38

## 0.0.18

### Patch Changes

- Updated dependencies [feecdae]
- Updated dependencies [a841071]
- Updated dependencies [68e0b26]
  - jazz-tools@0.18.37

## 0.0.17

### Patch Changes

- jazz-tools@0.18.36

## 0.0.16

### Patch Changes

- jazz-tools@0.18.35

## 0.0.15

### Patch Changes

- Updated dependencies [7a64465]
  - jazz-tools@0.18.34

## 0.0.14

### Patch Changes

- Updated dependencies [df0045e]
- Updated dependencies [5ffe0a9]
  - jazz-tools@0.18.33

## 0.0.13

### Patch Changes

- Updated dependencies [314c199]
  - jazz-tools@0.18.32

## 0.0.12

### Patch Changes

- jazz-tools@0.18.31

## 0.0.11

### Patch Changes

- Updated dependencies [b3dbcaa]
- Updated dependencies [75d452e]
- Updated dependencies [346c5fb]
- Updated dependencies [354895b]
- Updated dependencies [162757c]
- Updated dependencies [d08b7e2]
- Updated dependencies [ad19280]
  - jazz-tools@0.18.30

## 0.0.10

### Patch Changes

- Updated dependencies [cc7efc8]
- Updated dependencies [f55d17f]
  - jazz-tools@0.18.29

## 0.0.9

### Patch Changes

- Updated dependencies [8cbbe0e]
- Updated dependencies [14806c8]
  - jazz-tools@0.18.28

## 0.0.8

### Patch Changes

- Updated dependencies [6c6eb35]
- Updated dependencies [6ca0b59]
- Updated dependencies [88c5f1c]
  - jazz-tools@0.18.27

## 0.0.7

### Patch Changes

- Updated dependencies [4e0ea26]
  - jazz-tools@0.18.26

## 0.0.6

### Patch Changes

- Updated dependencies [4036737]
- Updated dependencies [8ae7d71]
- Updated dependencies [b1d0081]
- Updated dependencies [36a5c58]
- Updated dependencies [94e7d89]
  - jazz-tools@0.18.25

## 0.0.5

### Patch Changes

- Updated dependencies [f4c4ee9]
- Updated dependencies [a15e2ba]
  - jazz-tools@0.18.24

## 0.0.4

### Patch Changes

- Updated dependencies [a0c8a2d]
  - jazz-tools@0.18.23

## 0.0.3

### Patch Changes

- Updated dependencies [22200ac]
- Updated dependencies [1e20db6]
  - jazz-tools@0.18.22

## 0.0.2

### Patch Changes

- 6819f20: Implements SSR options for SvelteKit
- Updated dependencies [6819f20]
  - jazz-tools@0.18.21
