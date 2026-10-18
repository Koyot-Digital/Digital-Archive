import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { api, loginUrl } from "@/lib/api";
import { IconDiscord } from "@/components/icons";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * Why a sign-in was refused.
 *
 * Each message says what the viewer can do about it and nothing else. In
 * particular none of them name the roles that *would* work: the access list
 * is not something an unauthorised visitor should be able to enumerate by
 * reading the rejection.
 */
const DENIALS: Record<string, { title: string; detail: string }> = {
  not_member: {
    title: "You are not in the archive's Discord",
    detail:
      "Access is granted through a role in one Discord server, and your account is not a member of it. Ask whoever runs the archive for an invite.",
  },
  no_role: {
    title: "Your account has no access role",
    detail:
      "You are in the Discord server, but you do not hold a role that grants access to the archive. Ask a moderator to assign one, then sign in again.",
  },
};

/**
 * Sign-in page.
 *
 * The only route the archive serves without a session - which makes it the
 * one place that has to explain what is behind the gate and how to get past
 * it. Everything else redirects here.
 */
export default async function LoginPage({ searchParams }: Props) {
  const search = await searchParams;
  const error = one(search.error);
  const denied = one(search.denied);
  const returnTo = one(search.return_to) ?? "/";

  const viewer = await api.viewer().catch(() => null);
  // Already signed in and no refusal to explain: nothing to do here.
  if (viewer?.authenticated && !denied) redirect(returnTo);
  // AUTH_ENABLED=false - the bypass already grants admin, there is no flow.
  if (viewer && !viewer.authEnabled) redirect("/");

  const refusal = denied ? DENIALS[denied] : undefined;

  return (
    <div className="mx-auto max-w-sm py-20 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm leading-6 text-muted">
        This archive is private. Every record, image and search is restricted to Discord accounts
        holding an access role in the archive&apos;s server.
      </p>

      {refusal ? (
        <div className="mt-6 rounded-card border border-sev-critical/30 bg-sev-critical/10 px-3 py-2.5 text-left">
          <p className="text-xs font-semibold text-sev-critical">{refusal.title}</p>
          <p className="mt-1 text-2xs leading-5 text-sev-critical/90">{refusal.detail}</p>
        </div>
      ) : null}

      {error ? (
        <div className="mt-6 rounded-card border border-sev-critical/30 bg-sev-critical/10 px-3 py-2.5 text-left">
          <p className="text-xs font-semibold text-sev-critical">Discord returned: {error}</p>
          <p className="mt-1 text-2xs leading-5 text-sev-critical/90">
            If this keeps happening, the button below will ask Discord to re-confirm the
            permissions the archive needs to read your roles.
          </p>
        </div>
      ) : null}

      <a
        href={loginUrl(returnTo, Boolean(error))}
        className="btn btn-primary mt-8 inline-flex w-full items-center justify-center gap-2"
      >
        <IconDiscord className="h-4 w-4" />
        Continue with Discord
      </a>

      <p className="mt-4 text-2xs leading-5 text-faint">
        Only your Discord ID, username, avatar and the roles you hold in the archive&apos;s server
        are read. No messages, no email address, no other server.
      </p>
    </div>
  );
}
