import { PALETTES, type Palette, type ThemeName } from "../theme/palette";

// The worker's copy of which theme the map is in. It arrives as a message rather than riding along
// with every draw for the same reason the shed decks do: it is one small fact shared by every layer,
// it changes only when the reader flips the toggle, and the main thread redraws every tile when it
// does (src/tiles/layer.ts). Messages are delivered in order, so a draw posted after the change
// already sees it.

let theme: ThemeName = "light";

export function setWorkerTheme(next: ThemeName): void {
  theme = next;
}

export function palette(): Palette {
  return PALETTES[theme];
}

// Names the theme so a cache keyed on it can be invalidated; the palette itself is a fresh object
// only at module load, so identity is not a usable key.
export function themeName(): ThemeName {
  return theme;
}
