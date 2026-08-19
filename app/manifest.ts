import type { MetadataRoute } from "next";

// The install manifest. Every URL in it is relative, because a manifest's URLs resolve against the
// manifest's own address and the Pages deploy injects a basePath we never see here — "." is the
// site's root wherever it ends up served from, and an absolute "/" would be the domain's.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Scenic Route",
    short_name: "Scenic",
    description: "Walking directions that pick shade, trees and water over the shortest line",
    start_url: ".",
    scope: ".",
    // What makes the browser offer to install at all; also what drops the address bar afterwards.
    display: "standalone",
    orientation: "any",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
      { src: "./icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "./icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Full-bleed, because Android crops an icon to whatever shape the launcher uses and an "any"
      // icon gets a white plate behind it instead.
      {
        src: "./icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
