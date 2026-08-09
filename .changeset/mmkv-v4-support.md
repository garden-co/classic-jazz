---
"jazz-tools": patch
---

Support react-native-mmkv v4: use `createMMKV()` and `remove()` in the MMKV store adapter, which v4 renamed from the now-removed `new MMKV()` class and `delete()` method. Bumps the peer range to `^4.0.0`, and `react-native-nitro-modules` to `>=0.31.0` since mmkv v4 is built on Nitro.
