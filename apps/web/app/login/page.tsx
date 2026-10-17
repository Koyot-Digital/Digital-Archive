import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { api, loginUrl } from "@/lib/api";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Sign-in page.
 *
 * Reading the archive never requires an account; this exists only so
 * moderators can reach the tools. When AUTH_ENABLED=false the whole flow is
 * bypassed and this page redirects home.
 */
export default async function LoginPage({ searchParams }: Props) {
  const search = await searchParams;
  const error = Array.isArray(search.error) ? search.error[0] : search.error;
  const returnTo = (Array.isArray(search.return_to) ? search.return_to[0] : search.return_to) ?? "/";

  const viewer = await api.viewer().catch(() => null);
  if (viewer?.authenticated) redirect(returnTo);
  if (viewer && !viewer.authEnabled) redirect("/");

  return (
    <div className="mx-auto max-w-sm py-20 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm leading-6 text-muted">
        Reading the archive needs no account. Sign in only if you hold a moderator or administrator
        role.
      </p>

      {error ? (
        <p className="mt-6 rounded-card border border-sev-critical/30 bg-sev-critical/10 px-3 py-2 text-xs text-sev-critical">
          Discord returned: {error}
        </p>
      ) : null}

      <a href={loginUrl(returnTo)} className="btn btn-primary mt-8 w-full">
        Continue with Discord
      </a>

      <p className="mt-4 text-2xs text-faint">
        Only your Discord ID, username and avatar are stored. No messages, no email address.
      </p>

      <Link href="/" className="btn btn-ghost mt-6">
        Back to the archive
      </Link>
    </div>
  );
}
