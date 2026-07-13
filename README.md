# Scenic Route

A web app for tagging and annotating places along the way.

The map is the app: it opens at `/` for everyone, with a basemap and a tree-cover
overlay. Signing in as an admin adds the Firebase-backed pins — drop them at your
location and attach freeform notes.

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
