"use client";

import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { BsCircleHalf } from "react-icons/bs";
import { FiMoon, FiSun } from "react-icons/fi";

type ThemeChoice = "light" | "dark" | "system";

const META: Record<
  ThemeChoice,
  { label: string; next: ThemeChoice; Icon: typeof FiSun }
> = {
  light: { label: "Light theme", next: "dark", Icon: FiSun },
  dark: { label: "Dark theme", next: "system", Icon: FiMoon },
  system: { label: "System theme", next: "light", Icon: BsCircleHalf },
};

// next-themes hands back whatever string is in storage, so anything unrecognised (or the
// undefined it renders with on the server) falls back to the default choice
function toChoice(theme: string | undefined): ThemeChoice {
  return theme === "light" || theme === "dark" ? theme : "system";
}

export default function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState<boolean>(false);

  // next-themes is client-only; render a stable placeholder until mounted to avoid a hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  // The stored theme cannot be drawn before mount without a hydration mismatch, so until
  // then the button is the placeholder it renders on the server.
  const current: ThemeChoice = mounted ? toChoice(theme) : "system";

  // The choice the next click steps from — always the one the button is announcing, so it
  // does what its label says even before mount. A click moves it on straight away rather
  // than waiting for the re-render: setTheme resolves against the theme of the render it
  // was taken from, so without this two clicks landing in one React batch would both pick
  // the same target and the second would be swallowed.
  const stepFrom = useRef<ThemeChoice>(current);
  useEffect(() => {
    stepFrom.current = current;
  }, [current]);

  const handleClick = () => {
    const target = META[stepFrom.current].next;
    stepFrom.current = target;
    setTheme(target);
  };

  const { label, next, Icon } = META[current];

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`${label}. Click to switch to ${META[next].label.toLowerCase()}.`}
      title={`${label} — click for ${META[next].label.toLowerCase()}`}
      className={
        className ??
        "grid h-10 w-10 place-items-center rounded-full bg-white/85 text-slate-700 shadow-lg ring-1 ring-black/5 backdrop-blur-md transition hover:bg-white dark:bg-slate-800/80 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-slate-800"
      }
      suppressHydrationWarning
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
