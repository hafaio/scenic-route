"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_SETTINGS,
  type Settings,
  settings,
  subscribeSettings,
} from "../src/settings/store";

export function useSettings(): Settings {
  return useSyncExternalStore(
    subscribeSettings,
    settings,
    () => DEFAULT_SETTINGS,
  );
}
