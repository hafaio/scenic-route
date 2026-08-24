import { FACTORS, type FactorKey } from "../routing/factors";
import { DEFAULT_SETTINGS, type Settings } from "./store";

// Settings across two devices.
//
// Local-first, and that is not a fallback: localStorage is always this device's truth, nothing
// reaches Firebase until the reader signs in, and signing out leaves everything where it is. What
// signing in buys is a merge, not a master copy.
//
// The merge is per FIELD rather than per document, decided by which side changed that field last —
// so a phone that set the layer order and a laptop that moved the tree slider both keep what they
// did, where a whole-document last-writer-wins would have thrown one of them away. Weights are
// merged per factor for the same reason.
//
// Clock skew makes this approximate: two devices whose clocks differ by a minute can order two edits
// a few seconds apart wrongly. At settings stakes that is the right trade against the machinery
// exact ordering would need.

// Everything the merge decides, as the paths `Settings.updatedAt` is keyed by. A field absent from
// this list is not synced at all — which is the right answer for anything about THIS device.
const FIELDS = [
  "layerOrder",
  "hiddenLayers",
  "factorOrder",
  "hiddenFactors",
  "hiddenGates",
  "allowFerries",
  "allowSheds",
  "coverage",
] as const;

type SyncedField = (typeof FIELDS)[number];

const weightPath = (key: FactorKey): string => `weights.${key}`;

// Which side of a field to take: the one that changed it later, and the local one when neither has
// ever changed it or the two are somehow simultaneous. Preferring local on a tie is what keeps a
// sign-in from moving anything the reader has not touched on another device.
function later(
  local: Readonly<Record<string, number>>,
  remote: Readonly<Record<string, number>>,
  path: string,
): "local" | "remote" {
  return (remote[path] ?? -1) > (local[path] ?? -1) ? "remote" : "local";
}

export function mergeSettings(local: Settings, remote: Settings): Settings {
  const merged: Settings = { ...local, updatedAt: { ...local.updatedAt } };
  const stamps: Record<string, number> = { ...local.updatedAt };

  for (const field of FIELDS) {
    if (later(local.updatedAt, remote.updatedAt, field) === "remote") {
      // Every field is assigned through this one line, so the types are widened at the assignment
      // rather than the loop being written out eight times.
      (merged as Record<SyncedField, unknown>)[field] = remote[field];
      stamps[field] = remote.updatedAt[field];
    }
  }

  const weights: Partial<Record<FactorKey, number>> = { ...local.weights };
  for (const { key } of FACTORS) {
    const path = weightPath(key);
    if (later(local.updatedAt, remote.updatedAt, path) === "remote") {
      const weight = remote.weights[key];
      if (weight === undefined) {
        delete weights[key];
      } else {
        weights[key] = weight;
      }
      stamps[path] = remote.updatedAt[path];
    }
  }

  merged.weights = weights;
  merged.updatedAt = stamps;
  return merged;
}

// A document read back from Firestore, which is whatever was last written there — by a build that
// may be newer than this one. Everything unrecognised is dropped rather than trusted, the same way
// the local document is read (./store.ts), so a field this build cannot name cannot corrupt it.
export function settingsFromRemote(
  document: unknown,
  read: (stored: Partial<Settings>) => Settings,
): Settings {
  if (typeof document !== "object" || document === null) {
    return DEFAULT_SETTINGS;
  } else {
    return read(document as Partial<Settings>);
  }
}
