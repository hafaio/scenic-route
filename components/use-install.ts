"use client";

import { useCallback, useEffect, useState } from "react";

// Chromium fires this before showing its own install affordance; preventing it hands the offer to
// the menu row, and the saved event is the only way to open that flow later — it cannot be
// constructed, and it is spent once prompted. Safari and Firefox never fire it at all, which is
// what the instructions dialog is for.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

function isInstalled(): boolean {
  const nav: Navigator & { standalone?: boolean } = window.navigator;
  // `standalone` is iOS Safari's own flag; it predates display-mode and is still the only signal a
  // home-screen launch gives there.
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    nav.standalone === true
  );
}

// Whether to offer installing at all, and the browser's own install flow when it has one. `install`
// resolves false when there is none, and the caller should explain the browser's menu instead.
export function useInstall(): {
  installable: boolean;
  install: () => Promise<boolean>;
} {
  const [offer, setOffer] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(false);

  useEffect(() => {
    setInstalled(isInstalled());
    const onOffer = (event: Event) => {
      event.preventDefault();
      setOffer(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setOffer(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onOffer);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onOffer);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!offer) {
      return false;
    } else {
      // Dropped whether they accept or decline: the event is spent, and Chromium fires a fresh one
      // if the site is still installable next load.
      setOffer(null);
      try {
        await offer.prompt();
        return true;
      } catch {
        // Thrown when the event has already been prompted, or when the gesture that reached here
        // was not fresh enough to carry one. Reported as no flow rather than swallowed, so the
        // click still lands on the instructions instead of doing nothing at all.
        return false;
      }
    }
  }, [offer]);

  return { installable: !installed, install };
}
