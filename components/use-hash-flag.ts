"use client";

import { useCallback, useEffect, useState } from "react";

// A boolean bound to a URL hash fragment, so a dialog is deep-linkable (e.g. `#about`) and the browser
// back button dismisses it. Opening pushes a history entry (the URL gains the hash, shareable); closing
// strips the hash. Close strips rather than popping the entry so it behaves the same however the dialog
// was reached — including a visitor who landed directly on the hash, who has no entry to pop.
export function useHashFlag(name: string): [boolean, (open: boolean) => void] {
  const hash = `#${name}`;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const sync = () => setOpen(window.location.hash === hash);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [hash]);

  const set = useCallback(
    (next: boolean) => {
      const active = window.location.hash === hash;
      if (next === active) {
        return;
      }
      if (next) {
        window.location.hash = name; // pushes a history entry and fires hashchange
      } else {
        // Drop the hash without navigating; replaceState doesn't fire hashchange, so close by hand.
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search,
        );
        setOpen(false);
      }
    },
    [hash, name],
  );

  return [open, set];
}
