import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/chrome";

export const metadata: Metadata = {
  title: "About",
  description: "How this archive works, what it keeps, and how to get something corrected.",
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-prose animate-fade-up">
      <PageHeader
        breadcrumbs={[{ label: "Archive", href: "/" }, { label: "About" }]}
        title="About this archive"
      />

      <div className="prose-archive">
        <p>
          This is a moderation-record archive. It collects publicly observable Roblox and Discord moderation
          actions, stores the evidence that supports each one, and keeps the full history of every
          change made to a record after it was filed.
        </p>

        <h2>What a record contains</h2>
        <p>Every entry carries, at minimum:</p>
        <ul>
          <li>
            <strong>A subject</strong> - the account the record is about, on either Roblox or
            Discord, identified by its numeric ID on that platform rather than by a username,
            because usernames change. The two are separate namespaces: the same digits on Roblox
            and on Discord are two different accounts, and the archive never conflates them.
          </li>
          <li>
            <strong>Grouped accounts</strong>, where a record names more than one - alts, a
            rename, or the Discord and Roblox accounts belonging to one person. One sanction
            announced against four accounts stays one record, filed under the first account
            named, with the others linked to it in both directions.
          </li>
          <li>
            <strong>A source</strong> - which scraper or person filed it, and the URL it came from
            where one exists.
          </li>
          <li>
            <strong>A stated reason</strong> and a severity, so a note is never mistaken for a
            termination.
          </li>
          <li>
            <strong>Evidence</strong> - screenshots, converted to WebP and served from a dedicated
            image service, each with its own permanent URL.
          </li>
          <li>
            <strong>A revision history</strong> - see below.
          </li>
        </ul>

        <h2>Nothing changes silently</h2>
        <p>
          Records are editable, because records are sometimes wrong. But every edit snapshots the
          previous state and requires the editor to say why, and both are shown publicly at the
          bottom of the record. A record that has been removed keeps its URL and its history: the
          body stops being served, and the removal itself becomes an audit entry.
        </p>
        <p>
          The moderation log is append-only at the database level. Entries cannot be edited or
          deleted - not by a moderator, not by an administrator, and not by a compromised API
          token.
        </p>

        <h2 id="corrections">Corrections</h2>
        <p>
          If a record about you or someone else is inaccurate, say which record (quote its 16-
          character ID, shown in the sidebar) and what specifically is wrong. Corrections are
          applied as edits with a stated reason, so the original claim and its correction both
          remain visible. That is deliberate: quietly deleting a mistake is how an archive loses
          the right to be trusted.
        </p>
        <p>
          Records are removed outright only where keeping them would be unlawful or where the
          subject is identifiable and the material is genuinely harmful rather than merely
          unflattering.
        </p>

        <h2>Scope and limits</h2>
        <p>
          This archive is not operated by Roblox Corporation and has no access to internal
          moderation systems. Everything here is derived from publicly visible information. An
          absence of records means only that nothing has been archived - not that nothing happened.
        </p>

        <p>
          The read API is open and documented at <Link href="/api-docs">/api-docs</Link>.
        </p>
      </div>
    </div>
  );
}
