// @ts-check

// Not TypeScript, and it cannot become TypeScript: the Pages deploy runs actions/configure-pages
// with `static_site_generator: next`, which injects the basePath by editing a `next.config.js`. With
// only a `.ts` here it finds nothing to edit and writes its own `module.exports` template instead,
// which this package rejects — it is `"type": "module"` — and the deploy dies in `bun export` with
// "module is not defined in ES module scope". Nothing catches it earlier, because a push or a PR
// stops at lint and tests and never runs the Pages path.
//
// `@ts-check` above and the annotation below get the type checking anyway; tsconfig names this file
// in `include`, so `bun run lint` reads it.

/** @type {import("next").NextConfig} */
export default {
  images: { unoptimized: true },
  output: "export",
  // basePath is injected at deploy time by actions/configure-pages, not hardcoded here
};
