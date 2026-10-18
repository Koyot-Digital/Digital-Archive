"use client";

import { useRef, useState } from "react";
import { cx } from "@/lib/format";

/**
 * Upload a Discord forum scrape from the browser.
 *
 * The file is split client-side and posted in batches, for two reasons that
 * are not negotiable: Caddy caps the ingress path at 10MB per request, and the
 * batch schema caps a request at 500 threads. Batching also means a 500-thread
 * export reports progress instead of looking hung for six minutes.
 *
 * The key is held in component state and nowhere else - not localStorage, not
 * a cookie, not the URL - so closing the tab discards it.
 */

const MAX_POSTS_PER_BATCH = 150;
/** Well under Caddy's 10MB so a single outsized thread cannot tip a batch over. */
const MAX_BYTES_PER_BATCH = 4 * 1024 * 1024;

interface Counts {
  received: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  imagesQueued: number;
}

interface Unmapped {
  index: number;
  sourceId: string;
  title: string;
  reason: string;
}

const EMPTY: Counts = {
  received: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
  imagesQueued: 0,
};

/** Group threads into requests that respect both the count and the byte cap. */
function batchPosts(posts: unknown[]): unknown[][] {
  const batches: unknown[][] = [];
  let current: unknown[] = [];
  let bytes = 0;

  for (const post of posts) {
    const size = JSON.stringify(post).length;
    if (current.length && (current.length >= MAX_POSTS_PER_BATCH || bytes + size > MAX_BYTES_PER_BATCH)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(post);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function IngestForm({ apiBase }: { apiBase: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [apiKey, setApiKey] = useState("");
  const [onConflict, setOnConflict] = useState<"merge" | "skip" | "replace">("merge");
  const [dryRun, setDryRun] = useState(false);
  const [fetchImages, setFetchImages] = useState(true);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [totals, setTotals] = useState<Counts>(EMPTY);
  const [unmapped, setUnmapped] = useState<Unmapped[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file || !apiKey.trim() || running) return;

    setRunning(true);
    setFatal(null);
    setNotes([]);
    setUnmapped([]);
    setTotals(EMPTY);
    setProgress({ done: 0, total: 0 });

    try {
      const text = await file.text();
      const lines = text.split("\n");
      const posts: unknown[] = [];
      let unreadable = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          posts.push(JSON.parse(trimmed));
        } catch {
          unreadable += 1;
        }
      }

      if (!posts.length) {
        setFatal(
          unreadable
            ? `No readable threads: all ${unreadable} non-empty line(s) failed to parse as JSON.`
            : "That file contains no threads.",
        );
        return;
      }

      const collected: string[] = [];
      if (unreadable) {
        collected.push(`${unreadable} line(s) were not valid JSON and were left out.`);
      }

      const batches = batchPosts(posts);
      setProgress({ done: 0, total: batches.length });

      const running_totals = { ...EMPTY };
      const collectedUnmapped: Unmapped[] = [];

      for (const [i, batch] of batches.entries()) {
        const res = await fetch(`${apiBase}/ingress/discord-forum`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey.trim() },
          body: JSON.stringify({ onConflict, dryRun, fetchImages, posts: batch }),
        });

        const body = (await res.json().catch(() => null)) as
          | { counts?: Counts; unmapped?: Unmapped[]; error?: { code: string; message: string } }
          | null;

        // An auth or signature problem fails every remaining batch too, so
        // stop rather than hammering the endpoint 40 more times.
        if (res.status === 401 || res.status === 403) {
          setFatal(
            body?.error?.message ??
              `The API rejected the key (HTTP ${res.status}). If INGRESS_HMAC_SECRET is set on the server, this endpoint also demands a signed body, which a browser cannot produce.`,
          );
          return;
        }

        if (res.status === 422 && body?.error?.code === "nothing_mappable") {
          running_totals.failed += batch.length;
          collected.push(`Batch ${i + 1}: ${body.error.message}`);
        } else if (!res.ok) {
          running_totals.failed += batch.length;
          collected.push(
            `Batch ${i + 1} failed (HTTP ${res.status})${body?.error?.message ? `: ${body.error.message}` : ""}`,
          );
        } else if (body?.counts) {
          for (const key of Object.keys(running_totals) as (keyof Counts)[]) {
            running_totals[key] += body.counts[key] ?? 0;
          }
        }

        if (body?.unmapped?.length) collectedUnmapped.push(...body.unmapped);

        setProgress({ done: i + 1, total: batches.length });
        setTotals({ ...running_totals });
        setUnmapped([...collectedUnmapped]);
        setNotes([...collected]);
      }
    } catch (err) {
      setFatal(err instanceof Error ? err.message : "The upload failed.");
    } finally {
      setRunning(false);
    }
  }

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const finished = !running && progress.total > 0 && progress.done === progress.total;

  return (
    <div className="space-y-6">
      <form onSubmit={run} className="card space-y-5 p-5">
        <div className="space-y-1.5">
          <label htmlFor="scrape" className="block text-sm font-medium">
            Scrape file
          </label>
          <input
            ref={fileRef}
            id="scrape"
            type="file"
            accept=".jsonl,.json,.txt"
            required
            disabled={running}
            className={cx(
              "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg",
              "file:mr-3 file:rounded file:border-0 file:bg-raised file:px-2.5 file:py-1",
              "file:text-xs file:text-fg hover:border-line-strong",
            )}
          />
          <p className="text-xs text-muted">
            One JSON thread per line, as the scraper writes it - the same file{" "}
            <code className="font-mono text-2xs">make ingest</code> takes.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="key" className="block text-sm font-medium">
            API key
          </label>
          <input
            id="key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="da_…"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={running}
            className={cx(
              "w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-fg",
              "placeholder:text-faint hover:border-line-strong focus:border-accent",
            )}
          />
          <p className="text-xs text-muted">
            Needs the <code className="font-mono text-2xs">ingress:write</code> scope. Kept in this
            page only - never stored, never sent anywhere but the API.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="conflict" className="block text-sm font-medium">
              Already archived
            </label>
            <select
              id="conflict"
              value={onConflict}
              onChange={(e) => setOnConflict(e.target.value as "merge" | "skip" | "replace")}
              disabled={running}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg hover:border-line-strong"
            >
              <option value="merge">merge - update, but never overwrite a moderator&apos;s edit</option>
              <option value="skip">skip - leave existing records untouched</option>
              <option value="replace">replace - overwrite, including moderator edits</option>
            </select>
          </div>

          <fieldset className="space-y-2.5 pt-1">
            <legend className="mb-1 text-sm font-medium">Options</legend>
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={fetchImages}
                onChange={(e) => setFetchImages(e.target.checked)}
                disabled={running}
                className="mt-0.5"
              />
              <span>
                Fetch attachments
                <span className="block text-xs text-muted">
                  Discord signs its links for about a day; an old export mostly 404s.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                disabled={running}
                className="mt-0.5"
              />
              <span>
                Dry run
                <span className="block text-xs text-muted">Parse and report, write nothing.</span>
              </span>
            </label>
          </fieldset>
        </div>

        <div className="flex items-center gap-3 border-t border-line pt-4">
          <button type="submit" disabled={running} className="btn btn-primary">
            {running ? `Uploading… ${pct}%` : dryRun ? "Check the file" : "Ingest"}
          </button>
          {running || finished ? (
            <span className="text-xs text-muted">
              batch {progress.done} of {progress.total}
            </span>
          ) : null}
        </div>

        {progress.total > 0 ? (
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1 w-full overflow-hidden rounded bg-raised"
          >
            <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
      </form>

      {fatal ? (
        <div className="card border-sev-critical/40 p-4">
          <h2 className="text-sm font-semibold text-sev-critical">Stopped</h2>
          <p className="mt-1 text-sm text-muted">{fatal}</p>
        </div>
      ) : null}

      {progress.total > 0 ? (
        <div className="card p-5">
          <h2 className="text-sm font-semibold">
            {dryRun ? "Would import" : finished ? "Imported" : "Importing…"}
          </h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {(
              [
                ["received", "threads sent"],
                ["created", "new records"],
                ["updated", "updated"],
                ["skipped", "skipped"],
                ["failed", "not placed"],
                ["imagesQueued", "attachments queued"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd
                  className={cx(
                    "font-mono text-lg",
                    key === "failed" && totals.failed ? "text-sev-high" : undefined,
                  )}
                >
                  {totals[key]}
                </dd>
              </div>
            ))}
          </dl>
          {fetchImages && !dryRun && totals.imagesQueued ? (
            <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
              Attachments are converted after the response, so the count above is what was handed
              to the images service rather than what landed. Ones already held are skipped without
              being re-downloaded.
            </p>
          ) : null}
        </div>
      ) : null}

      {notes.length ? (
        <div className="card p-5">
          <h2 className="text-sm font-semibold">Notes</h2>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            {notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {unmapped.length ? (
        <div className="card p-5">
          <h2 className="text-sm font-semibold">
            Not placed <span className="text-muted">({unmapped.length})</span>
          </h2>
          <p className="mt-1 text-xs text-muted">
            Reported rather than dropped, so the scrape can be fixed at the source. Almost always a
            title that names no account id.
          </p>
          <ul className="mt-3 space-y-2.5">
            {unmapped.slice(0, 50).map((row) => (
              <li key={`${row.sourceId}-${row.index}`} className="border-t border-line pt-2.5">
                <p className="truncate text-sm">{row.title || <em className="text-faint">no title</em>}</p>
                <p className="text-xs text-muted">{row.reason}</p>
              </li>
            ))}
          </ul>
          {unmapped.length > 50 ? (
            <p className="mt-3 text-xs text-faint">
              …and {unmapped.length - 50} more.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
