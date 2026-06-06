"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { BsCircleHalf } from "react-icons/bs";
import { FiMoon, FiSun } from "react-icons/fi";

type ThemeChoice = "light" | "dark" | "system";

const ORDER: ThemeChoice[] = ["light", "dark", "system"];

const META: Record<
  ThemeChoice,
  { label: string; next: ThemeChoice; Icon: typeof FiSun }
> = {
  light: { label: "Light theme", next: "dark", Icon: FiSun },
  dark: { label: "Dark theme", next: "system", Icon: FiMoon },
  system: { label: "System theme", next: "light", Icon: BsCircleHalf },
};

export default function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState<boolean>(false);

  // next-themes is client-only — render a stable placeholder during SSR /
  // first paint so React doesn't trip the hydration mismatch guard.
  useEffect(() => {
    setMounted(true);
  }, []);

  const current: ThemeChoice = mounted
    ? ORDER.includes(theme as ThemeChoice)
      ? (theme as ThemeChoice)
      : "system"
    : "system";
  const { label, next, Icon } = META[current];

  const handleClick = () => {
    setTheme(next);
  };

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
