"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cx } from "@/lib/format";

/**
 * Search entry point.
 *
 * Submits as a plain navigation to /search so results are server-rendered,
 * shareable and indexable; the only client-side behaviour is the "/" shortcut
 * that moderators expect from Linear-style tools.
 *
 * The current query arrives as a prop rather than from useSearchParams():
 * this component sits in the layout header, and reading search params there
 * would opt every otherwise-static page out of prerendering.
 */
export function SearchBox({
  compact = false,
  defaultValue = "",
}: {
  compact?: boolean;
  defaultValue?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === inputRef.current) {
        inputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const query = value.trim();
    if (query.length < 2) return;
    router.push(`/search?q=${encodeURIComponent(query)}`);
  }

  return (
    <form role="search" onSubmit={submit} className={compact ? "" : "w-full"}>
      <label className="relative block">
        <span className="sr-only">Search the archive</span>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <circle cx="6.75" cy="6.75" r="4.75" />
          <path d="M10.5 10.5 14 14" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          name="q"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={compact ? "Search" : "Search records, usernames or account IDs"}
          autoComplete="off"
          spellCheck={false}
          className={cx(
            "w-full rounded-md border border-line bg-surface pl-8 pr-9 text-sm text-fg placeholder:text-faint",
            "transition-colors hover:border-line-strong focus:border-accent",
            compact ? "h-8 sm:w-56" : "h-11",
          )}
        />
        {!value ? (
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-2xs text-faint sm:block">
            /
          </kbd>
        ) : null}
      </label>
    </form>
  );
}
