# Scenic Route

Nicer ways to walk across New York. The map is the app: it opens at `/` for
everyone and routes on foot, biasing the path toward tree cover, sun or shade,
landmarks, public art, nice commercial streets and ferries — and away from
highways.

## Using it

- Tap the **layers** button to toggle overlays like tree canopy or building
  shade, and drag the **clock** to see how shade shifts through the day.
- Open **Directions**, set a start and destination, then open the sliders to
  bias the route toward what you care about — the summary reports how much of
  each the route picks up.
- **Drag** either endpoint on the map to nudge the route, and drop it to lock
  the new point in.

Signing in as an admin adds Firebase-backed pins — drop them at your location
and attach freeform notes.

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
