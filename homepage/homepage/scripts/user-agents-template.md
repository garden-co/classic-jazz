# AGENTS.md

**Classic Jazz documentation — for existing Classic Jazz projects**

Classic Jazz is no longer under active development. **For new projects, use Jazz v2.0 or later and the [current documentation](https://jazz.tools/docs).**

**Use this documentation only when your project uses Classic Jazz.** Its APIs and examples are not guidance for Jazz v2.0 or later. If you are unsure which version your project uses, check its dependencies before following these instructions.

Guidelines for AI agents working on this Jazz app.

## Jazz Overview

Jazz is a framework for building local-first apps with real-time sync, offline support, and end-to-end encryption. Data is defined as collaborative values (CoValues) that sync automatically between clients.

### Key Concepts

- **CoValue**: Core collaborative data type. Variants: `CoMap` (key-value), `CoList` (ordered list), `CoFeed` (per-user streams), `CoPlainText` (collaborative text), `FileStream` (files/images)
- **Group**: Permission entity that controls read/write access to CoValues
- **Account**: User identity with profile and root data
- **Schema**: Define your data model using `co.map()`, `co.list()`, etc. with Zod-style field types

### Schema Conventions

- Define schemas in a dedicated `schema.ts` file
- Use `co.map({...})` for structured data, `co.list(ItemType)` for ordered collections
- Reference other CoValues by type (e.g., `tasks: co.list(Task)`) for automatic deep loading
- Use `z.string()`, `z.number()`, `z.boolean()`, `z.literal()`, `z.enum()` for primitive fields

### Import Patterns

- Import schema helpers from `jazz-tools`: `import { co, z, Group } from "jazz-tools"`
- Import framework bindings from the appropriate subpath (e.g., `jazz-tools/react`, `jazz-tools/svelte`)
- Use `useCoState` (React) or equivalent to subscribe to CoValue changes

## Skills

You have the following skills available:

- [Jazz Schema Design](.skills/jazz-schema-design/SKILL.md) — designing and evolving Jazz schemas
- [Jazz Performance](.skills/jazz-performance/SKILL.md) — optimising Jazz app performance
- [Jazz Permissions & Security](.skills/jazz-permissions-security/SKILL.md) — groups, roles, and access control
- [Jazz Testing](.skills/jazz-testing/SKILL.md) — testing Jazz apps
- [Jazz UI Development](.skills/jazz-ui-development/SKILL.md) — building UIs with Jazz framework bindings

## Full Documentation

For comprehensive docs, see [.cursor/docs/llms-full.md](.cursor/docs/llms-full.md).

## Docs Index

The index below provides a compact map of all available documentation pages.

<!--DOCS_INDEX_START-->
<!--DOCS_INDEX_END-->
