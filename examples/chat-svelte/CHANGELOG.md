# passkey-svelte

## 0.0.210

### Patch Changes

- Updated dependencies [ea0ca5c]
- Updated dependencies [9385ad4]
  - jazz-tools@0.20.20

## 0.0.209

### Patch Changes

- Updated dependencies [b13e956]
- Updated dependencies [dc43d1d]
  - jazz-tools@0.20.19

## 0.0.208

### Patch Changes

- Updated dependencies [ab2e90b]
- Updated dependencies [12b27e1]
- Updated dependencies [1c6e9ff]
- Updated dependencies [ab2e90b]
  - jazz-tools@0.20.18

## 0.0.207

### Patch Changes

- Updated dependencies [d26dccc]
- Updated dependencies [6572f1f]
- Updated dependencies [754df86]
  - jazz-tools@0.20.17

## 0.0.206

### Patch Changes

- Updated dependencies [f45aca2]
  - jazz-tools@0.20.16

## 0.0.205

### Patch Changes

- Updated dependencies [05b28a9]
- Updated dependencies [53bd0c4]
- Updated dependencies [109afa7]
  - jazz-tools@0.20.15

## 0.0.204

### Patch Changes

- jazz-tools@0.20.14

## 0.0.203

### Patch Changes

- Updated dependencies [307b11d]
- Updated dependencies [1acba7b]
- Updated dependencies [53c2cc2]
  - jazz-tools@0.20.13

## 0.0.202

### Patch Changes

- Updated dependencies [9a43096]
  - jazz-tools@0.20.12

## 0.0.201

### Patch Changes

- Updated dependencies [191ce7a]
  - jazz-tools@0.20.11

## 0.0.200

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

## 0.0.199

### Patch Changes

- Updated dependencies [75ecd19]
  - jazz-tools@0.20.9

## 0.0.198

### Patch Changes

- Updated dependencies [8688239]
- Updated dependencies [fc4163a]
- Updated dependencies [c7be307]
- Updated dependencies [739ea48]
- Updated dependencies [b38a526]
- Updated dependencies [f701fd7]
- Updated dependencies [0fa9e15]
  - jazz-tools@0.20.8

## 0.0.197

### Patch Changes

- jazz-tools@0.20.7

## 0.0.196

### Patch Changes

- jazz-tools@0.20.6

## 0.0.195

### Patch Changes

- Updated dependencies [23a5d7c]
- Updated dependencies [0b95532]
  - jazz-tools@0.20.5

## 0.0.194

### Patch Changes

- Updated dependencies [0c749d9]
  - jazz-tools@0.20.4

## 0.0.193

### Patch Changes

- jazz-tools@0.20.3

## 0.0.192

### Patch Changes

- Updated dependencies [2df568f]
  - jazz-tools@0.20.2

## 0.0.191

### Patch Changes

- Updated dependencies [ca306c0]
- Updated dependencies [d7f9cba]
  - jazz-tools@0.20.1

## 0.0.190

### Patch Changes

- Updated dependencies [6b9368a]
- Updated dependencies [ee19292]
- Updated dependencies [8934d8a]
  - jazz-tools@0.20.0

## 0.0.189

### Patch Changes

- Updated dependencies [89d8798]
- Updated dependencies [30b5339]
  - jazz-tools@0.19.22

## 0.0.186

### Patch Changes

- Updated dependencies [171e1c6]
- Updated dependencies [053a283]
- Updated dependencies [41b2cf4]
- Updated dependencies [923bc8e]
- Updated dependencies [83f84ca]
  - jazz-tools@0.19.19

## 0.0.185

### Patch Changes

- Updated dependencies [729d46c]
  - jazz-tools@0.19.18

## 0.0.184

### Patch Changes

- Updated dependencies [d46cffd]
  - jazz-tools@0.19.17

## 0.0.183

### Patch Changes

- Updated dependencies [25268bf]
  - jazz-tools@0.19.16

## 0.0.182

### Patch Changes

- Updated dependencies [94012a1]
- Updated dependencies [86f9676]
- Updated dependencies [b27dbc2]
  - jazz-tools@0.19.15

## 0.0.181

### Patch Changes

- jazz-tools@0.19.14

## 0.0.180

### Patch Changes

- Updated dependencies [bef1cc6]
- Updated dependencies [b839147]
  - jazz-tools@0.19.13

## 0.0.179

### Patch Changes

- Updated dependencies [9ca9e72]
- Updated dependencies [5b0bb7d]
- Updated dependencies [fa0759b]
- Updated dependencies [a2372db]
  - jazz-tools@0.19.12

## 0.0.178

### Patch Changes

- Updated dependencies [68acca4]
- Updated dependencies [c00a454]
  - jazz-tools@0.19.11

## 0.0.177

### Patch Changes

- jazz-tools@0.19.10

## 0.0.176

### Patch Changes

- Updated dependencies [d901caa]
- Updated dependencies [a2bb9f0]
  - jazz-tools@0.19.9

## 0.0.175

### Patch Changes

- Updated dependencies [21f7d34]
- Updated dependencies [b22ad89]
- Updated dependencies [28b23dd]
  - jazz-tools@0.19.8

## 0.0.174

### Patch Changes

- Updated dependencies [e113a79]
  - jazz-tools@0.19.7

## 0.0.173

### Patch Changes

- Updated dependencies [23782f0]
- Updated dependencies [56d74e4]
- Updated dependencies [bc9120b]
  - jazz-tools@0.19.6

## 0.0.172

### Patch Changes

- jazz-tools@0.19.5

## 0.0.171

### Patch Changes

- Updated dependencies [78dfffd]
- Updated dependencies [de2f8b5]
- Updated dependencies [763977a]
- Updated dependencies [e02e14c]
- Updated dependencies [3aaba61]
  - jazz-tools@0.19.4

## 0.0.170

### Patch Changes

- Updated dependencies [cddbfdb]
- Updated dependencies [114e4ce]
  - jazz-tools@0.19.3

## 0.0.169

### Patch Changes

- Updated dependencies [ef24afb]
- Updated dependencies [5f2b34b]
  - jazz-tools@0.19.2

## 0.0.168

### Patch Changes

- Updated dependencies [f444bd9]
  - jazz-tools@0.19.1

## 0.0.167

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

## 0.0.166

### Patch Changes

- Updated dependencies [349ca48]
  - jazz-tools@0.18.38

## 0.0.165

### Patch Changes

- Updated dependencies [feecdae]
- Updated dependencies [a841071]
- Updated dependencies [68e0b26]
  - jazz-tools@0.18.37

## 0.0.164

### Patch Changes

- jazz-tools@0.18.36

## 0.0.163

### Patch Changes

- jazz-tools@0.18.35

## 0.0.162

### Patch Changes

- Updated dependencies [7a64465]
  - jazz-tools@0.18.34

## 0.0.161

### Patch Changes

- Updated dependencies [df0045e]
- Updated dependencies [5ffe0a9]
  - jazz-tools@0.18.33

## 0.0.160

### Patch Changes

- Updated dependencies [314c199]
  - jazz-tools@0.18.32

## 0.0.159

### Patch Changes

- jazz-tools@0.18.31

## 0.0.158

### Patch Changes

- Updated dependencies [b3dbcaa]
- Updated dependencies [75d452e]
- Updated dependencies [346c5fb]
- Updated dependencies [354895b]
- Updated dependencies [162757c]
- Updated dependencies [d08b7e2]
- Updated dependencies [ad19280]
  - jazz-tools@0.18.30

## 0.0.157

### Patch Changes

- Updated dependencies [cc7efc8]
- Updated dependencies [f55d17f]
  - jazz-tools@0.18.29

## 0.0.156

### Patch Changes

- Updated dependencies [8cbbe0e]
- Updated dependencies [14806c8]
  - jazz-tools@0.18.28

## 0.0.155

### Patch Changes

- Updated dependencies [6c6eb35]
- Updated dependencies [6ca0b59]
- Updated dependencies [88c5f1c]
  - jazz-tools@0.18.27

## 0.0.154

### Patch Changes

- Updated dependencies [4e0ea26]
  - jazz-tools@0.18.26

## 0.0.153

### Patch Changes

- Updated dependencies [4036737]
- Updated dependencies [8ae7d71]
- Updated dependencies [b1d0081]
- Updated dependencies [36a5c58]
- Updated dependencies [94e7d89]
  - jazz-tools@0.18.25

## 0.0.152

### Patch Changes

- Updated dependencies [f4c4ee9]
- Updated dependencies [a15e2ba]
  - jazz-tools@0.18.24

## 0.0.151

### Patch Changes

- Updated dependencies [a0c8a2d]
  - jazz-tools@0.18.23

## 0.0.150

### Patch Changes

- Updated dependencies [22200ac]
- Updated dependencies [1e20db6]
  - jazz-tools@0.18.22

## 0.0.149

### Patch Changes

- Updated dependencies [6819f20]
  - jazz-tools@0.18.21

## 0.0.148

### Patch Changes

- Updated dependencies [c34a793]
- Updated dependencies [2c01529]
- Updated dependencies [7b0facc]
- Updated dependencies [47c7dd3]
- Updated dependencies [d0e2210]
  - jazz-tools@0.18.20

## 0.0.147

### Patch Changes

- Updated dependencies [f88db5f]
- Updated dependencies [8eac2fc]
- Updated dependencies [08b6c03]
  - jazz-tools@0.18.19

## 0.0.146

### Patch Changes

- Updated dependencies [f2f478a]
- Updated dependencies [ed7e353]
- Updated dependencies [1698d41]
  - jazz-tools@0.18.18

## 0.0.145

### Patch Changes

- Updated dependencies [75d1afa]
- Updated dependencies [8aa4acd]
  - jazz-tools@0.18.17

## 0.0.144

### Patch Changes

- Updated dependencies [67b95b7]
  - jazz-tools@0.18.16

## 0.0.143

### Patch Changes

- Updated dependencies [a584ab3]
  - jazz-tools@0.18.15

## 0.0.142

### Patch Changes

- Updated dependencies [a04435e]
  - jazz-tools@0.18.14

## 0.0.141

### Patch Changes

- Updated dependencies [2ddf4d9]
- Updated dependencies [45981cf]
  - jazz-tools@0.18.13

## 0.0.140

### Patch Changes

- Updated dependencies [c16ce4b]
- Updated dependencies [0b1b050]
  - jazz-tools@0.18.12

## 0.0.139

### Patch Changes

- Updated dependencies [06b4617]
- Updated dependencies [70eb465]
  - jazz-tools@0.18.11

## 0.0.138

### Patch Changes

- jazz-tools@0.18.10

## 0.0.137

### Patch Changes

- Updated dependencies [c8167de]
- Updated dependencies [910b8d6]
  - jazz-tools@0.18.9

## 0.0.136

### Patch Changes

- Updated dependencies [700fe46]
- Updated dependencies [aba0d55]
  - jazz-tools@0.18.8

## 0.0.135

### Patch Changes

- Updated dependencies [cf26739]
- Updated dependencies [a3cd9c8]
- Updated dependencies [ca5cd26]
- Updated dependencies [32d1444]
  - jazz-tools@0.18.7

## 0.0.134

### Patch Changes

- Updated dependencies [975d1c3]
- Updated dependencies [ccbb795]
- Updated dependencies [0dae338]
- Updated dependencies [934679c]
- Updated dependencies [28defd0]
- Updated dependencies [e0f17ed]
- Updated dependencies [88ef339]
  - jazz-tools@0.18.6

## 0.0.133

### Patch Changes

- Updated dependencies [ff35d8c]
- Updated dependencies [f23a7a7]
- Updated dependencies [f5d8424]
- Updated dependencies [4e976b8]
  - jazz-tools@0.18.5

## 0.0.132

### Patch Changes

- Updated dependencies [84313aa]
- Updated dependencies [89aab7b]
  - jazz-tools@0.18.4

## 0.0.131

### Patch Changes

- Updated dependencies [b526ab6]
- Updated dependencies [d69aa68]
  - jazz-tools@0.18.3

## 0.0.130

### Patch Changes

- jazz-tools@0.18.2

## 0.0.129

### Patch Changes

- Updated dependencies [af5fbe7]
- Updated dependencies [9837459]
  - jazz-tools@0.18.1

## 0.0.128

### Patch Changes

- f263856: Add `$jazz` field to CoValues:
  - This field contains Jazz methods that cluttered CoValues' API, as well as Jazz internal properties. This field is not enumerable, to allow CoValues to behave similarly to JSON objects.
  - Added a `$jazz.set` method to update a CoValue's fields. When updating collaborative fields, you can pass in JSON objects instead of CoValues and Jazz will create
    the CoValues automatically (similarly to CoValue `create` methods).
  - All CoMap methods have been moved into `$jazz`, to allow defining any arbitrary key in the CoMap (except for `$jazz`) without conflicts.
    - For CoMaps created with `co.map`, fields are now `readonly` to prevent setting properties directly. Use the `$jazz.set` method instead.
    - CoMaps created with class schemas don't get type errors on direct property assignments, but they get a runtime errors prompting indicating to use `$jazz.set`.
    - the `delete` operator can no longer be used to delete CoRecord properties. Use `$jazz.delete` instead.
  - CoList's array-mutation methods have been moved into `$jazz`, in order to prevent using methods
    - CoLists are now readonly arrays. Trying to use any mutation method yields a type error.
    - `$jazz.set` can be used in place of direct element assignments.
    - Added two new utility methods: `$jazz.remove` and `$jazz.retain`. They allow editing a CoList in-place with a simpler API than `$jazz.splice`.
    - `sort`, `reverse`, `fill` and `copyWithin` have been deprecated, given that they could behave inconsistently with CoLists. `$jazz` replacements may be introduced
      in future releases.
  - `.$jazz.owner` now always returns a Group (instead of a Group or an Account). We'll be migrating away of having Accounts as CoValue owners in future releases.
  - Removed `castAs`, since it's an inherently unsafe operation that bypassed typechecking and enabled using CoValues in unsupported ways.
  - Removed the `id` and `_type` fields from `toJSON()`'s output in Account, CoMap, CoFeed & FileStream, to make CoValues behave more similarly to JSON objects.
  - Removed the `root` and `profile` fields from Group.
- Updated dependencies [f263856]
  - jazz-tools@0.18.0

## 0.0.127

### Patch Changes

- Updated dependencies [cc2f774]
  - jazz-tools@0.17.14

## 0.0.126

### Patch Changes

- Updated dependencies [d208cd1]
- Updated dependencies [7821a8b]
  - jazz-tools@0.17.13

## 0.0.125

### Patch Changes

- 1ccae1a: RN Expo E2E dependency fixes w catalog
- Updated dependencies [1ccae1a]
  - jazz-tools@0.17.12

## 0.0.124

### Patch Changes

- Updated dependencies [8f3852b]
- Updated dependencies [bb9d837]
  - jazz-tools@0.17.11

## 0.0.123

### Patch Changes

- jazz-tools@0.17.10

## 0.0.122

### Patch Changes

- Updated dependencies [52ea0c7]
  - jazz-tools@0.17.9

## 0.0.121

### Patch Changes

- Updated dependencies [ac3e694]
- Updated dependencies [6dbb053]
- Updated dependencies [1a182f0]
  - jazz-tools@0.17.8

## 0.0.120

### Patch Changes

- jazz-tools@0.17.7

## 0.0.119

### Patch Changes

- Updated dependencies [82de51c]
- Updated dependencies [694b168]
  - jazz-tools@0.17.6

## 0.0.118

### Patch Changes

- Updated dependencies [5963658]
  - jazz-tools@0.17.5

## 0.0.117

### Patch Changes

- Updated dependencies [7dd3d00]
  - jazz-tools@0.17.4

## 0.0.116

### Patch Changes

- jazz-tools@0.17.3

## 0.0.115

### Patch Changes

- Updated dependencies [794681a]
- Updated dependencies [83fc22f]
  - jazz-tools@0.17.2

## 0.0.114

### Patch Changes

- Updated dependencies [0bcbf55]
- Updated dependencies [d1bdbf5]
- Updated dependencies [4b73834]
  - jazz-tools@0.17.1

## 0.0.113

### Patch Changes

- Updated dependencies [fcaf4b9]
  - jazz-tools@0.17.0

## 0.0.112

### Patch Changes

- Updated dependencies [67e0968]
- Updated dependencies [2c8120d]
  - jazz-tools@0.16.6

## 0.0.111

### Patch Changes

- Updated dependencies [3cd1586]
- Updated dependencies [33ebbf0]
  - jazz-tools@0.16.5

## 0.0.110

### Patch Changes

- Updated dependencies [16764f6]
  - jazz-tools@0.16.4

## 0.0.109

### Patch Changes

- Updated dependencies [43d3511]
  - jazz-tools@0.16.3

## 0.0.108

### Patch Changes

- jazz-tools@0.16.2

## 0.0.107

### Patch Changes

- Updated dependencies [c62abef]
  - jazz-tools@0.16.1

## 0.0.106

### Patch Changes

- 2bbb07b: Introduce a cleaner separation between Zod and CoValue schemas:
  - Zod schemas and CoValue schemas are fully separated. Zod schemas can only be composed with other Zod schemas. CoValue schemas can be composed with either Zod or other CoValue schemas.
  - `z.optional()` and `z.discriminatedUnion()` no longer work with CoValue schemas. Use `co.optional()` and `co.discriminatedUnion()` instead.
  - Internal schema access is now simpler. You no longer need to use Zod’s `.def` to access internals. Use properties like `CoMapSchema.shape`, `CoListSchema.element`, and `CoOptionalSchema.innerType` directly.
  - CoValue schema types are now namespaced under `co.`. Non-namespaced exports have been removed
  - CoMap schemas no longer incorrectly inherit from Zod. Previously, methods like `.extend()` and `.partial()` appeared available but could cause unexpected behavior. These methods are now disabled. In their place, `.optional()` has been added, and more Zod-like methods will be introduced in future releases.
  - Upgraded Zod from `3.25.28` to `3.25.76`.
  - Removed deprecated `withHelpers` method from CoValue schemas
  - Removed deprecated `createCoValueObservable` function
- Updated dependencies [c09dcdf]
- Updated dependencies [2bbb07b]
  - jazz-tools@0.16.0

## 0.0.105

### Patch Changes

- Updated dependencies [9633d01]
- Updated dependencies [4beafb7]
  - jazz-tools@0.15.16

## 0.0.104

### Patch Changes

- Updated dependencies [3fe53a3]
  - jazz-tools@0.15.15

## 0.0.103

### Patch Changes

- Updated dependencies [a584590]
- Updated dependencies [9acccb5]
  - jazz-tools@0.15.14

## 0.0.102

### Patch Changes

- Updated dependencies [6c76ff8]
  - jazz-tools@0.15.13

## 0.0.101

### Patch Changes

- Updated dependencies [d1c1b0c]
- Updated dependencies [cf4ad72]
  - jazz-tools@0.15.12

## 0.0.100

### Patch Changes

- Updated dependencies [bdc9aee]
  - jazz-tools@0.15.11

## 0.0.99

### Patch Changes

- Updated dependencies [9815ec6]
- Updated dependencies [b4fdab4]
  - jazz-tools@0.15.10

## 0.0.98

### Patch Changes

- Updated dependencies [27b4837]
  - jazz-tools@0.15.9

## 0.0.97

### Patch Changes

- Updated dependencies [3844666]
  - jazz-tools@0.15.8

## 0.0.96

### Patch Changes

- Updated dependencies [c09b636]
  - jazz-tools@0.15.7

## 0.0.95

### Patch Changes

- Updated dependencies [a5ceaff]
  - jazz-tools@0.15.6

## 0.0.94

### Patch Changes

- Updated dependencies [23bfea5]
- Updated dependencies [e4ba23c]
- Updated dependencies [4b89838]
  - jazz-tools@0.15.5

## 0.0.93

### Patch Changes

- jazz-tools@0.15.4

## 0.0.92

### Patch Changes

- Updated dependencies [45f73a7]
  - jazz-tools@0.15.3

## 0.0.91

### Patch Changes

- Updated dependencies [0e7e532]
  - jazz-tools@0.15.2

## 0.0.90

### Patch Changes

- Updated dependencies [0e3a4d2]
- Updated dependencies [b110f00]
  - jazz-tools@0.15.1

## 0.0.89

### Patch Changes

- Updated dependencies [1378a1f]
- Updated dependencies [0fa051a]
  - jazz-tools@0.15.0

## 0.0.88

### Patch Changes

- Updated dependencies [06c5a1c]
  - jazz-tools@0.14.28
  - jazz-browser-media-images@0.14.28
  - jazz-svelte@0.14.28

## 0.0.87

### Patch Changes

- Updated dependencies [a026073]
  - jazz-tools@0.14.27
  - jazz-browser-media-images@0.14.27
  - jazz-svelte@0.14.27

## 0.0.86

### Patch Changes

- Updated dependencies [e35a380]
  - jazz-svelte@0.14.26
  - jazz-tools@0.14.26
  - jazz-browser-media-images@0.14.26

## 0.0.85

### Patch Changes

- Updated dependencies [99a2d9b]
  - jazz-tools@0.14.25
  - jazz-browser-media-images@0.14.25
  - jazz-svelte@0.14.25

## 0.0.84

### Patch Changes

- jazz-svelte@0.13.30
- jazz-tools@0.13.30

## 0.0.83

### Patch Changes

- jazz-svelte@0.13.29
- jazz-tools@0.13.29

## 0.0.82

### Patch Changes

- jazz-svelte@0.13.28
- jazz-tools@0.13.28

## 0.0.81

### Patch Changes

- jazz-svelte@0.13.27
- jazz-tools@0.13.27

## 0.0.80

### Patch Changes

- Updated dependencies [ff846d9]
  - jazz-tools@0.13.26
  - jazz-svelte@0.13.26

## 0.0.79

### Patch Changes

- jazz-svelte@0.13.25
- jazz-tools@0.13.25

## 0.0.78

### Patch Changes

- Updated dependencies [ec546b4]
  - jazz-svelte@0.13.24

## 0.0.77

### Patch Changes

- Updated dependencies [3431076]
- Updated dependencies [02a240c]
  - jazz-svelte@0.13.23
  - jazz-tools@0.13.23

## 0.0.76

### Patch Changes

- jazz-svelte@0.13.21
- jazz-tools@0.13.21

## 0.0.75

### Patch Changes

- Updated dependencies [439f0fe]
  - jazz-tools@0.13.20
  - jazz-svelte@0.13.20

## 0.0.74

### Patch Changes

- Updated dependencies [80530a4]
  - jazz-tools@0.13.19
  - jazz-svelte@0.13.19

## 0.0.73

### Patch Changes

- Updated dependencies [761759c]
  - jazz-tools@0.13.18
  - jazz-svelte@0.13.18

## 0.0.72

### Patch Changes

- jazz-svelte@0.13.17
- jazz-tools@0.13.17

## 0.0.71

### Patch Changes

- jazz-svelte@0.13.16
- jazz-tools@0.13.16

## 0.0.70

### Patch Changes

- jazz-svelte@0.13.15
- jazz-tools@0.13.15

## 0.0.69

### Patch Changes

- jazz-svelte@0.13.14
- jazz-tools@0.13.14

## 0.0.68

### Patch Changes

- jazz-svelte@0.13.13
- jazz-tools@0.13.13

## 0.0.67

### Patch Changes

- Updated dependencies [4547525]
  - jazz-tools@0.13.12
  - jazz-svelte@0.13.12

## 0.0.66

### Patch Changes

- Updated dependencies [17273a6]
  - jazz-tools@0.13.11
  - jazz-svelte@0.13.11

## 0.0.65

### Patch Changes

- jazz-svelte@0.13.10
- jazz-tools@0.13.10

## 0.0.64

### Patch Changes

- Updated dependencies [a6cf01f]
  - jazz-tools@0.13.9
  - jazz-svelte@0.13.9

## 0.0.63

### Patch Changes

- jazz-svelte@0.13.7

## 0.0.62

### Patch Changes

- jazz-svelte@0.13.5

## 0.0.61

### Patch Changes

- jazz-svelte@0.13.4

## 0.0.60

### Patch Changes

- jazz-svelte@0.13.3

## 0.0.59

### Patch Changes

- jazz-svelte@0.13.2

## 0.0.58

### Patch Changes

- jazz-svelte@0.13.0

## 0.0.57

### Patch Changes

- jazz-svelte@0.12.2

## 0.0.56

### Patch Changes

- jazz-svelte@0.12.1

## 0.0.55

### Patch Changes

- jazz-svelte@0.12.0

## 0.0.54

### Patch Changes

- jazz-svelte@0.11.8

## 0.0.53

### Patch Changes

- jazz-svelte@0.11.7

## 0.0.52

### Patch Changes

- 1bfa9bb: Removed when="singedUp" from examples apps' Jazz providers. This is a really niche use-case option and can lead to broken-feeling experiences when anonymous users try to load something.
  - jazz-svelte@0.11.6

## 0.0.51

### Patch Changes

- jazz-svelte@0.11.5

## 0.0.50

### Patch Changes

- jazz-svelte@0.11.4

## 0.0.49

### Patch Changes

- jazz-svelte@0.11.3

## 0.0.48

### Patch Changes

- jazz-svelte@0.11.2

## 0.0.47

### Patch Changes

- jazz-svelte@0.11.0

## 0.0.46

### Patch Changes

- jazz-svelte@0.10.15

## 0.0.45

### Patch Changes

- jazz-svelte@0.10.14

## 0.0.44

### Patch Changes

- jazz-svelte@0.10.13

## 0.0.43

### Patch Changes

- Updated dependencies [4612e05]
  - jazz-svelte@0.10.12

## 0.0.42

### Patch Changes

- jazz-svelte@0.10.9

## 0.0.41

### Patch Changes

- jazz-svelte@0.10.8

## 0.0.40

### Patch Changes

- Updated dependencies [1136d9b]
  - jazz-svelte@0.10.7

## 0.0.39

### Patch Changes

- jazz-svelte@0.10.6

## 0.0.38

### Patch Changes

- jazz-svelte@0.10.5

## 0.0.37

### Patch Changes

- jazz-svelte@0.10.4

## 0.0.36

### Patch Changes

- jazz-svelte@0.10.3

## 0.0.35

### Patch Changes

- jazz-svelte@0.10.2

## 0.0.34

### Patch Changes

- jazz-svelte@0.10.1

## 0.0.33

### Patch Changes

- Updated dependencies [b426342]
  - jazz-svelte@0.10.0

## 0.0.32

### Patch Changes

- jazz-svelte@0.9.23

## 0.0.31

### Patch Changes

- jazz-svelte@0.9.22

## 0.0.30

### Patch Changes

- jazz-svelte@0.9.21

## 0.0.29

### Patch Changes

- jazz-svelte@0.9.20

## 0.0.28

### Patch Changes

- jazz-svelte@0.9.19

## 0.0.27

### Patch Changes

- jazz-svelte@0.9.18

## 0.0.26

### Patch Changes

- jazz-svelte@0.9.17

## 0.0.25

### Patch Changes

- jazz-svelte@0.9.16

## 0.0.24

### Patch Changes

- jazz-svelte@0.9.15

## 0.0.23

### Patch Changes

- jazz-svelte@0.9.14

## 0.0.22

### Patch Changes

- jazz-svelte@0.9.13

## 0.0.21

### Patch Changes

- jazz-svelte@0.9.12

## 0.0.20

### Patch Changes

- jazz-svelte@0.9.11

## 0.0.19

### Patch Changes

- jazz-svelte@0.9.10

## 0.0.18

### Patch Changes

- jazz-svelte@0.9.9

## 0.0.17

### Patch Changes

- jazz-svelte@0.9.8

## 0.0.16

### Patch Changes

- jazz-svelte@0.9.1

## 0.0.15

### Patch Changes

- Updated dependencies [9dd8d95]
  - jazz-svelte@0.9.0

## 0.0.14

### Patch Changes

- jazz-svelte@0.8.51

## 0.0.13

### Patch Changes

- jazz-svelte@0.8.50

## 0.0.12

### Patch Changes

- jazz-svelte@0.8.49

## 0.0.11

### Patch Changes

- jazz-svelte@0.8.48

## 0.0.10

### Patch Changes

- jazz-svelte@0.8.45

## 0.0.9

### Patch Changes

- jazz-svelte@0.8.44

## 0.0.8

### Patch Changes

- jazz-svelte@0.8.41

## 0.0.7

### Patch Changes

- jazz-svelte@0.8.40

## 0.0.6

### Patch Changes

- Updated dependencies [aa21072]
  - jazz-svelte@0.8.39

## 0.0.5

### Patch Changes

- jazz-svelte@0.8.38

## 0.0.4

### Patch Changes

- jazz-svelte@0.0.4

## 0.0.3

### Patch Changes

- jazz-svelte@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [0e59e65]
  - jazz-svelte@0.0.2
