/**
 * `react-native`'s entrypoint is Flow-typed source that Vite cannot parse, so
 * importing it from a test fails at transform time — before `vi.mock` gets a
 * chance to intercept. The vitest config aliases `react-native` here instead.
 *
 * Only what the adapters actually touch at module scope lives here; add to it
 * as more of the react-native surface gets tests.
 */
export const Platform = { OS: "ios" };
