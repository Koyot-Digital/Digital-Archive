import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PUBLIC_API_BASE, api, loginUrl } from "@/lib/api";
import { PageHeader } from "@/components/chrome";
import { IngestForm } from "@/components/ingest-form";

export const metadata: Metadata = {
  title: "Ingest a scrape",
  robots: { index: false, follow: false },
};

/** Role-dependent and private: never cache, never prerender. */
export const dynamic = "force-dynamic";

export default async function IngestPage() {
  const viewer = await api.viewer().catch(() => null);
  const role = viewer?.user?.role;

  if (!viewer?.authenticated) {
    if (viewer?.authEnabled) redirect(loginUrl("/ingest"));
    redirect("/");
  }

  // Stricter than /moderation on purpose: this writes records in bulk.
  if (role !== "admin") {
    return (
      <div className="mx-auto max-w-prose py-16 text-center">
        <h1 className="text-xl font-semibold">Administrators only</h1>
        <p className="mt-2 text-sm text-muted">
          Importing a scrape writes records in bulk, so it is held to the administrator role rather
          than the moderator one.
        </p>
        <Link href="/" className="btn btn-outline mt-6">
          Back to the archive
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        breadcrumbs={[{ label: "Archive", href: "/" }, { label: "Ingest" }]}
        title="Ingest a scrape"
        description="Upload a forum scrape from this machine. Records dedupe on their thread id and attachments on their contents, so re-uploading the same file adds nothing twice and fills only what is missing."
      />
      <IngestForm apiBase={PUBLIC_API_BASE} />
    </div>
  );
}
