"use client";

import { watchSettings, writeSettings } from "../firebase";
import {
  adoptSettings,
  settings,
  settingsFromDocument,
  subscribeSettings,
} from "./store";
import { mergeSettings, settingsFromRemote } from "./sync";

// Holding one reader's settings in step across their devices, for as long as they are signed in.
//
// Signing in merges rather than downloads: whatever this device has is merged with whatever the
// cloud has, field by field and slider by slider (./sync.ts), and the result is written to both. So
// settings made before signing in survive — they take part in the merge on their own timestamps
// rather than being treated as second class.

let stop: (() => void) | null = null;

// The last thing written, so the snapshot our own write comes back as does not start another one.
let mirrored: string | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

// A drag of one slider is dozens of settings changes, and each of them is a document. Waiting for
// the drag to stop turns that into one write.
const SETTLE_MS = 800;

function push(uid: string): void {
  const encoded = JSON.stringify(settings());
  if (encoded === mirrored) {
    return;
  }
  mirrored = encoded;
  // A failed write is a device that is offline, or a reader whose rules have never been deployed.
  // Neither is worth surfacing: the settings are already saved locally, which is where they live.
  void writeSettings(uid, JSON.parse(encoded) as object).catch(() => {
    mirrored = null; // so the next change tries again rather than believing this one landed
  });
}

function pushSoon(uid: string): void {
  if (pending !== null) {
    clearTimeout(pending);
  }
  pending = setTimeout(() => {
    pending = null;
    push(uid);
  }, SETTLE_MS);
}

export function startSettingsSync(uid: string): void {
  stopSettingsSync();
  const unwatch = watchSettings(
    uid,
    (document) => {
      const remote = settingsFromRemote(document, settingsFromDocument);
      const merged = mergeSettings(settings(), remote);
      adoptSettings(merged);
      // Written back whenever the merge produced something the cloud does not already hold — the
      // first sign-in, and any time this device had a field the other one had not seen.
      pushSoon(uid);
    },
    () => {
      // No rules for this document, or no permission. Nothing to retry against, so the mirror stops
      // rather than writing on every later change; the app carries on entirely locally.
      stopSettingsSync();
    },
  );
  const unsubscribe = subscribeSettings(() => {
    pushSoon(uid);
  });
  stop = () => {
    unwatch();
    unsubscribe();
  };
}

// Signing out stops the mirror and changes nothing: the settings are this device's either way.
export function stopSettingsSync(): void {
  stop?.();
  stop = null;
  mirrored = null;
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
}
