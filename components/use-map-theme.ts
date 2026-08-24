"use client";

import { useSyncExternalStore } from "react";
import { currentTheme, subscribeTheme } from "../src/theme/current";
import type { ThemeName } from "../src/theme/palette";

// The theme the map draws in, for the React half. It reads the same `dark` class on <html> that the
// stylesheet does (src/theme/current.ts), so a component and the tile beside it can never disagree.
// Server rendering has no class to read and gets the light palette, which is what the markup that
// arrives before the provider's inline script runs is styled as anyway.
export function useMapTheme(): ThemeName {
  return useSyncExternalStore(subscribeTheme, currentTheme, () => "light");
}
