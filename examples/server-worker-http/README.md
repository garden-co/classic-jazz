# Rock Paper Scissors with Jazz HTTP API

This example demonstrates how to use the **Jazz HTTP API** with **Next.js** to implement updates in a trusted environment. The application implements a multiplayer Rock Paper Scissors game where the server validates game actions and reveals player intentions only after both players have made their moves.

## 🎯 Key Concepts Demonstrated

### Trusted Environment Updates
- **Server-side validation**: All game actions are validated by the server before being applied
- **Secure reveal mechanism**: Player choices are hidden until both players have acted, built with Jazz group permissions

## 🚀 Getting Started

### Prerequisites
- Node.js 20+ 
- pnpm (recommended) or npm

### Installation

1. **Install dependencies**:
   ```bash
   pnpm install
   ```

2. **Generate environment variables**:
   ```bash
   pnpm generate-env
   ```

3. **Add your API key** (available free from https://dashboard.jazz.tools)
   ```
   NEXT_PUBLIC_JAZZ_API_KEY=
   ```

4. **Start the development server**:
   ```bash
   pnpm dev
   ```

5. **Open your browser** to [http://localhost:3000](http://localhost:3000)

### Environment Setup

The `generate-env.ts` script creates the necessary environment variables for Jazz:
- `NEXT_PUBLIC_JAZZ_WORKER_ACCOUNT`: Server worker account ID
- `JAZZ_WORKER_SECRET`: Server worker secret key

Set `NEXT_PUBLIC_JAZZ_SYNC_SERVER` to use a self-hosted sync server. Worker provisioning, the server worker, and browser clients all use this URL.

### Local end-to-end tests

```bash
pnpm test:e2e:local
```

This starts an in-memory sync server, provisions a worker, builds the app, and runs Playwright against that same server. It does not require Jazz Cloud or write worker credentials to an environment file.

## 🔧 Key Implementation Details

### Server API Definition
```typescript
const playRequest = experimental_defineRequest({
  url: "/api/play",
  workerId,
  request: {
    schema: {
      game: Game,
      selection: z.literal(["rock", "paper", "scissors"]),
    },
    resolve: {
      game: {
        player1: { account: true, playSelection: { group: true } },
        player2: { account: true, playSelection: { group: true } },
      },
    },
  },
  response: {
    schema: { game: Game },
    resolve: { game: true },
  },
});
```

### Secure Move Handling
```typescript
// Create restricted group for the move
const group = Group.create({ owner: jazzServerAccount.worker });
group.addMember(madeBy, "reader");

// Store move with restricted access
const playSelection = PlaySelection.create(
  { value: selection, group },
  group,
);

// Reveal moves only after both players have acted
if (player1PlaySelection && player2PlaySelection) {
  player1PlaySelection.group.addMember(game.player2.account, "reader");
  player2PlaySelection.group.addMember(game.player1.account, "reader");
}
```

## 🎯 Use Cases

This pattern is ideal for applications requiring:

- **Fair play guarantees**: Preventing cheating in games
- **Simultaneous reveals**: Auctions, voting, or sealed-bid systems
- **Trusted computation**: Server-side validation of complex business logic
- **Real-time collaboration**: Multi-user applications with strict rules

## 📚 Learn More

- [Jazz Documentation](https://jazz.tools/docs)
- [Next.js App Router](https://nextjs.org/docs/app)
- [Groups & Permissions](https://jazz.tools/docs/react/groups/intro)
- [HTTP API with experimental_defineRequest](https://jazz.tools/docs/react/server-side/http-requests)

## 🤝 Contributing

This example is part of the Jazz framework. Feel free to submit issues and enhancement requests!
