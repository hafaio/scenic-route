import type { NextConfig } from "next";

// Empty in dev so localhost:3000/logger works; the project-site prefix kicks
// in for production builds (next build / next export).
const basePath =
  process.env.NODE_ENV === "production" ? "/scenic-route" : "";

const nextConfig: NextConfig = {
  images: { unoptimized: true },
  output: "export",
  basePath,
  assetPrefix: basePath,
};

export default nextConfig;
