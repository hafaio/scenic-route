"use client";

import { useEffect } from "react";

// Registers ./sw.js, relative to the document so it picks up the basePath the Pages deploy injects.
// Its scope is its own directory, which is the site root, matching the manifest's.
export default function ServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      // Fails on an insecure origin and whenever the user has workers switched off; neither is worth
      // reporting, since the only thing lost is the browser's offer to install.
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }, []);
  return null;
}
