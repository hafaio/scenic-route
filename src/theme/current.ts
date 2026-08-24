"use client";

import type { ThemeName } from "./palette";

// The theme the map is drawing in, for the parts of the app that are not React: the Leaflet layers
// and, through them, the tile worker.
//
// next-themes owns the choice, and the way it expresses it is a `dark` class on <html> — the same
// thing every `dark:` rule in the stylesheet reads. So this watches that class rather than keeping a
// second copy of the decision that could disagree with the CSS for a frame.

const listeners = new Set<() => void>();

function read(): ThemeName {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// Server-rendered, so there is no document yet; the class is on <html> before first paint (the
// provider's inline script puts it there), and the first read happens in a layer's effect.
let current: ThemeName = "light";

if (typeof document !== "undefined") {
  current = read();
  new MutationObserver(() => {
    const now = read();
    if (now !== current) {
      current = now;
      for (const listener of listeners) {
        listener();
      }
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

export function currentTheme(): ThemeName {
  return current;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
