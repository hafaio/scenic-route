import type { NextConfig } from "next";

export default {
  images: { unoptimized: true },
  output: "export",
  // basePath is injected at deploy time by actions/configure-pages (static_site_generator: next), not hardcoded here
} satisfies NextConfig;
