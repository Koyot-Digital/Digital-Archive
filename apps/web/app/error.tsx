"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Route-level error boundary.
 *
 * The digest is shown deliberately: it is the only handle a reader can quote
 * when reporting a failure, and it correlates with the server log.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("archive render error", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-prose py-20 text-center">
      <p className="font-mono text-xs uppercase tracking-widest text-sev-critical">Error</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Something broke</h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
        The archive could not render this page. The API may be restarting.
      </p>
      {error.digest ? (
        <p className="mt-3 font-mono text-2xs text-faint">digest {error.digest}</p>
      ) : null}

      <div className="mt-8 flex justify-center gap-2">
        <button type="button" onClick={reset} className="btn btn-primary">
          Try again
        </button>
        <Link href="/" className="btn btn-outline">
          Home
        </Link>
      </div>
    </div>
  );
}
