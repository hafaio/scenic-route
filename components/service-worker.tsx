"use client";

import { useEffect } from "react";
import { coverageBytes } from "../src/settings/offline";
import { settings, subscribeSettings } from "../src/settings/store";

// Registers ./sw.js, relative to the document so it picks up the basePath the Pages deploy injects.
// Its scope is its own directory, which is the site root, matching the manifest's.
//
// Also the page's half of the two settings the worker owns: it is TOLD its cap rather than asked for
// it, because it is stopped between requests and waking it to answer would put a round trip in front
// of every cache write. See the message handler in src/sw/worker.ts.

async function tellWorker(message: unknown): Promise<void> {
  const registration = await navigator.serviceWorker?.ready;
  registration?.active?.postMessage(message);
}

export function sendCoverage(coverage: string): void {
  void tellWorker({
    type: "overlay-cap",
    bytes: coverageBytes(coverage),
  }).catch(() => {});
}

export function clearOfflineMaps(): void {
  void tellWorker({ type: "clear-overlays" }).catch(() => {});
}

export default function ServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      // Fails on an insecure origin and whenever the user has workers switched off; neither is worth
      // reporting, since the only thing lost is the browser's offer to install.
      navigator.serviceWorker.register("sw.js").catch(() => {});
      // Sent on every load, not only on a change: a worker that has just replaced an older one, or
      // that was installed before this setting existed, has never been told.
      sendCoverage(settings().coverage);
    }
    // Asks the browser not to evict this origin under storage pressure. Only the page can ask — the
    // worker's StorageManager has no `persist` — and only once the site looks like something the
    // reader means to keep, which is what installing it or granting a permission signals. A refusal
    // is the normal answer and costs nothing: the caches still work, they are just evictable.
    void navigator.storage?.persist?.().catch(() => false);

    return subscribeSettings(() => {
      sendCoverage(settings().coverage);
    });
  }, []);
  return null;
}
