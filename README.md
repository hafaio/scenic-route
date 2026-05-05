# Scenic Route

A web app for tagging and annotating places along the way.

## Routes

- `/logger` — drop pins on a map, attach freeform notes. Admin-only,
  Firebase-backed.

## Development

```sh
bun install
bun run dev      # http://localhost:3000
bun run lint     # tsc + biome
bun run export   # static export to ./out
```

## Firebase

Configuration is hard-coded in `src/firebase.ts` (no env files). See
[`firestore.rules`](./firestore.rules) for the security rules to deploy
alongside the database. Setup instructions live in the project notes.
