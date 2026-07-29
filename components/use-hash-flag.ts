"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHash, hashParams } from "../src/url-state";

// A boolean bound to one key of the URL hash, so a dialog is deep-linkable (e.g. `#about`) and the
// browser back button dismisses it. The hash also carries the route state, so the flag is a key among
// the others and reads as set whether it has a value or not — `#about` and `#tree=0.5&about=1` both
// open it. Opening pushes a history entry (the URL gains the key, shareable); closing strips it. Close
// strips rather than popping the entry so it behaves the same however the dialog was reached —
// including a visitor who landed directly on the key, who has no entry to pop.
export function useHashFlag(name: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const sync = () => setOpen(hashParams(window.location.hash).has(name));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [name]);

  const set = useCallback(
    (next: boolean) => {
      const params = hashParams(window.location.hash);
      if (next === params.has(name)) {
        return;
      }
      if (next) {
        params.set(name, "1");
        window.location.hash = formatHash(params); // pushes a history entry and fires hashchange
      } else {
        params.delete(name);
        // Drop the key without navigating; replaceState doesn't fire hashchange, so close by hand.
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search + formatHash(params),
        );
        setOpen(false);
      }
    },
    [name],
  );

  return [open, set];
}
