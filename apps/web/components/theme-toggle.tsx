"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";
const STORAGE_KEY = "archive-theme";

/**
 * Theme switch.
 *
 * Writes `data-theme` on <html>, which globals.css keys off. The matching
 * inline script in the layout applies the stored value before first paint so
 * there is no flash of the wrong theme.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
      if (stored === "dark" || stored === "light") setTheme(stored);
    } catch {
      /* private mode: fall back to the system preference */
    }
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* non-fatal */
    }
  }

  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => apply(next)}
      className="btn btn-ghost w-8 px-0"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 1.5v11a5.5 5.5 0 0 1 0-11Z" />
      </svg>
    </button>
  );
}
