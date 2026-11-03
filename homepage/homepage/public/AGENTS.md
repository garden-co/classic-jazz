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

[Jazz Docs Index]|root:https://jazz.tools/docs
|LEGEND: b=base (no prefix), r=react, rn=react-native, rne=react-native-expo, s=svelte, v=vanilla, ss=server-side
|RULES: To fetch a page, append .md to the resolved URL path (e.g. https://jazz.tools/docs/react/quickstart.md). This returns clean markdown. Resolve paths as `[fw]/[dir]/[file].md`. If variant is 'b', omit the framework prefix: `[dir]/[file].md`.

|.:{api-reference:b|r|rn|rne|s|v{#Defining Schemas#Creating CoValues#Loading and Reading CoValues},index:b|r|rn|rne|s|v{#Quickstart#How it works#A Minimal Jazz App},project-setup:b|r|rn|rne|s|v{#Install dependencies#Write your schema#Give your app context},quickstart:b|r|rn|rne|s|v{#Create your App#Install Jazz#Get your free API key},troubleshooting:b|r|rn|rne|s|v{#Node.js version requirements#npx jazz-run: command not found},react-native-expo:b{#Quickstart#How it works#A Minimal Jazz App},react-native:b{#Quickstart#How it works#A Minimal Jazz App},react:b{#Quickstart#How it works#A Minimal Jazz App},svelte:b{#Quickstart#How it works#A Minimal Jazz App},vanilla:b{#Quickstart#How it works#A Minimal Jazz App}}
|core-concepts:{deleting:b|r|rn|rne|s|v{#Basic Usage#Deleting Nested CoValues#Handling Inaccessible Data},subscription-and-loading:b|r|rn|rne|s|v{#Subscription Hooks#Deep Loading#Loading Errors},sync-and-storage:b|r|rn|rne|s|v{#Using Jazz Cloud#Self-hosting your sync server}}
|core-concepts/covalues:{cofeeds:b|r|rn|rne|s|v{#Creating CoFeeds#Reading from CoFeeds#Writing to CoFeeds},colists:b|r|rn|rne|s|v{#Creating CoLists#Reading from CoLists#Updating CoLists},comaps:b|r|rn|rne|s|v{#Creating CoMaps#Reading from CoMaps#Updating CoMaps},cotexts:b|r|rn|rne|s|v{#`co.plainText()` vs `z.string()`#Creating CoText Values#Reading Text},covectors:b|r|rn|rne|s|v{#Creating CoVectors#Semantic Search#Embedding Models},filestreams:b|r|rn|rne|s|v{#Creating FileStreams#Reading from FileStreams#Writing to FileStreams},imagedef:b|r|rn|rne|s|v{#Installation \[!framework=react-native\]#Installation \[!framework=react-native-exp\]#Creating Images#Displaying Images#Custom image manipulation implementations},overview:b|r|rn|rne|s|v{#Start your app with a schema#Types of CoValues#CoValue field/item types}}
|core-concepts/schemas:{accounts-and-migrations:b|r|rn|rne|s|v{#CoValues as a graph of data rooted in accounts#Resolving CoValues starting at `profile` or `root`#Populating and evolving `root` and `profile` schemas with migrations},codecs:b|r|rn|rne|s|v{#Using Zod codecs},connecting-covalues:b|r|rn|rne|s|v,schemaunions:b|r|rn|rne|s|v{#Creating schema unions#Narrowing unions#Loading schema unions}}
|key-features:{history:b|r|rn|rne|s|v{#The $jazz.getEdits() method#Edit Structure#Accessing History},version-control:b|r|rn|rne|s|v{#Working with branches#Conflict Resolution#Private branches}}
|key-features/authentication:{authentication-states:b|r|rn|rne|s|v{#Anonymous Authentication#Authenticated Account#Guest Mode},better-auth-database-adapter:b|r|rn|rne|s|v{#Getting started#How it works#How to access the database},better-auth:b|r|rn|rne|s|v{#How it works#Authentication methods and plugins#Getting started},clerk:b|r|rn|rne|s|v{#How it works#Key benefits#Implementation},overview:b|r|rn|rne|s|v{#Authentication Flow#Available Authentication Methods},passkey:b|r|rn|rne|s|v{#How it works#Key benefits#Implementation},passphrase:b|r|rn|rne|s|v{#How it works#Key benefits#Implementation},quickstart:b|r|rn|rne|s|v{#Add passkey authentication#Give it a go!#Add a recovery method}}
|permissions-and-sharing:{cascading-permissions:b|r|rn|rne|s|v{#Basic usage#Levels of inheritance#Roles},overview:b|r|rn|rne|s|v{#Role Matrix#Creating a Group#Adding group members by ID},quickstart:b|r|rn|rne|s|v{#Understanding Groups#Create an invite link#Accept an invite},sharing:b|r|rn|rne|s|v{#Public sharing#Invites}}
|project-setup:{providers:b|r|rn|rne|s|v{#Setting up the Provider#Provider Options#Authentication}}
|reference:{data-modelling:b|r|rn|rne|s|v{#Jazz as a Collaborative Graph#Permissions are part of the data model#Choosing your building blocks},encryption:b|r|rn|rne|s|v{#How encryption works#Key rotation and security#Streaming encryption},faq:b|r|rn|rne|s|v{#How established is Jazz?#Will Jazz be around long-term?#How secure is my data?},performance:b|r|rn|rne|s|v{#Use the best crypto implementation for your platform#Initialize WASM asynchronously#Minimise group extensions},testing:b|r|rn|rne|s|v{#Core test helpers#Managing active Accounts#Managing Context},workflow-world:b|r|rn|rne|s|v{#Getting started#Get your free API key#Install the Jazz Workflow World}}
|reference/design-patterns:{form:b|r|rn|rne|s|v{#Updating a CoValue#Creating a CoValue#Writing the components in React},history-patterns:b|r|rn|rne|s|v{#Audit Logs#Activity Feeds#Change Indicators},organization:b|r|rn|rne|s|v{#Defining the schema for an Organization#Adding a list of Organizations to the user's Account#Adding members to an Organization}}
|server-side:{deployment:b|r|rn|rne|s|v{#Crypto implementations#WASM on Edge runtimes#Node-API},jazz-rpc:b|r|rn|rne|s|v{#Setting up JazzRPC#Handling JazzRPC requests on the server#Making requests from the client},quickstart:b|r|rn|rne|s|v{#Create Your App#Install Jazz#Set your API key},setup:b|r|rn|rne|s|v{#Generating credentials#Running a server worker#Storing & providing credentials},ssr:b|r|rn|rne|s|v{#Creating an agent#Telling Jazz to use the SSR agent#Making your data public}}
|server-side/communicating-with-workers:{http-requests:b|r|rn|rne|s|v{#Creating a Request#Authenticating requests#Multi-account environments},inbox:b|r|rn|rne|s|v{#Setting up the Inbox API#Sending messages from the client#Deployment considerations},overview:b|r|rn|rne|s|v{#Overview#JazzRPC (Recommended)#HTTP Requests}}
|tooling-and-resources:{ai-tools:b|r|rn|rne|s|v{#Setting up AI tools#llms.txt convention#Limitations and considerations},create-jazz-app:b|r|rn|rne|s|v{#Quick Start with Starter Templates#Command Line Options#Start From an Example App},inspector:b|r|rn|rne|s|v{#Exporting current account to Inspector from your app#Embedding the Inspector widget into your app \[!framework=react,svelte,vue,vanilla\]},mcp-server:b|r|rn|rne|s|v{#Installation#Tools#See also}}

<!--DOCS_INDEX_END-->
