import type { Metadata } from "next";
import { PUBLIC_API_BASE } from "@/lib/api";
import { PageHeader } from "@/components/chrome";

export const metadata: Metadata = {
  title: "API",
  description: "Read endpoints, the ingress contract and the image pipeline.",
};

/**
 * Human-facing API reference.
 *
 * Kept as a page rather than a static markdown file so it always reflects
 * this deployment's actual base URL.
 */

const READ_ENDPOINTS: [string, string][] = [
  ["GET /stats", "Archive counts, per-source and per-action breakdowns, compression savings."],
  ["GET /subjects?q=&sort=&page=", "Accounts with at least one published record."],
  ["GET /modlogs?action=&severity=&page=", "All published records, newest first."],
  ["GET /search?q=", "Full-text search. Supports quoted phrases and -exclusions."],
  ["GET /roblox-modlogs/:robloxId", "One account's records, with the subject inlined."],
  ["GET /roblox-modlogs/:robloxId/:logId", "One record with images, link embeds and subject."],
  ["GET /roblox-modlogs/:robloxId/:logId/:imageId", "Image metadata plus its siblings."],
  ["GET /modlogs/:id", "Flat record lookup by id."],
  ["GET /modlogs/:id/revisions", "Edit history, newest revision first."],
];

const IMAGE_ENDPOINTS: [string, string][] = [
  ["GET /images/:id.webp", "Full-size WebP. Immutable, cached for a year."],
  ["GET /images/:id.webp?v=thumb", "Thumbnail variant."],
  ["GET /images/:id/meta", "Dimensions, byte sizes and compression ratio."],
  ["POST /images", "multipart/form-data upload. Requires images:write."],
  ["POST /images/fetch", "Fetch remote URLs server-side. Requires images:write."],
];

export default function ApiDocsPage() {
  return (
    <div className="mx-auto max-w-prose animate-fade-up">
      <PageHeader
        breadcrumbs={[{ label: "Archive", href: "/" }, { label: "API" }]}
        title="API"
        description="Reads are public. Writes need either a Discord session with a role, or an API key with the matching scope."
      />

      <section className="mb-8">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">
          Base URLs
        </h2>
        <pre className="overflow-x-auto rounded-card border border-line bg-raised p-4 font-mono text-xs leading-6">
          {`text   ${PUBLIC_API_BASE}
images ${PUBLIC_API_BASE}/images/`}
        </pre>
        <p className="mt-2 text-xs leading-5 text-muted">
          The two run as separate services behind separate tunnels. Text responses are JSON; image
          responses are WebP bytes.
        </p>
      </section>

      <EndpointTable title="Read endpoints" rows={READ_ENDPOINTS} />
      <EndpointTable title="Images" rows={IMAGE_ENDPOINTS} />

      <section className="mb-8">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">
          Ingress
        </h2>
        <p className="mb-3 text-sm leading-6 text-muted">
          Scrapers POST batches to <code className="font-mono text-xs">/ingress</code>. Batches are
          idempotent for 24 hours: resubmitting the same{" "}
          <code className="font-mono text-xs">batchId</code> returns the original result instead of
          writing again.
        </p>
        <pre className="overflow-x-auto rounded-card border border-line bg-raised p-4 font-mono text-xs leading-6">
          {`curl -X POST ${PUBLIC_API_BASE}/ingress \\
  -H "Authorization: Bearer da_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "batchId": "nightly-2026-10-17",
    "onConflict": "merge",
    "records": [{
      "robloxId": 156,
      "username": "builderman",
      "title": "7-day suspension",
      "body": "Markdown body. Links become embeds.",
      "action": "temp_ban",
      "severity": "high",
      "reason": "Harassment",
      "occurredAt": "2026-03-02T10:30:00Z",
      "source": "my-scraper",
      "sourceId": "case-88213",
      "tags": ["harassment"],
      "evidence": { "reportCount": 3 },
      "imageUrls": ["https://example.com/evidence.png"]
    }]
  }'`}
        </pre>
        <ul className="mt-3 space-y-1.5 text-xs leading-5 text-muted">
          <li>
            <strong className="text-fg">onConflict</strong> —{" "}
            <code className="font-mono">merge</code> (default) updates the record unless a human has
            edited it, <code className="font-mono">replace</code> always overwrites,{" "}
            <code className="font-mono">skip</code> never touches an existing record.
          </li>
          <li>
            <strong className="text-fg">Dedupe</strong> — on{" "}
            <code className="font-mono">source</code> + <code className="font-mono">sourceId</code>.
            Omit sourceId and the server derives one from the content.
          </li>
          <li>
            <strong className="text-fg">Partial success</strong> — a failed record is reported by
            index in <code className="font-mono">errors</code>; the rest still land. The response is
            207 if everything failed.
          </li>
          <li>
            <strong className="text-fg">Limits</strong> — 500 records and 8MB per batch, 24 images
            per record.
          </li>
          <li>
            <strong className="text-fg">Signing</strong> — if the server has{" "}
            <code className="font-mono">INGRESS_HMAC_SECRET</code> set, send{" "}
            <code className="font-mono">X-Archive-Signature: sha256=&lt;hex&gt;</code> over the raw
            body.
          </li>
        </ul>
        <p className="mt-3 text-xs leading-5 text-muted">
          Check a credential without writing:{" "}
          <code className="font-mono text-xs">GET /ingress/whoami</code>.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">Errors</h2>
        <pre className="overflow-x-auto rounded-card border border-line bg-raised p-4 font-mono text-xs leading-6">
          {`{
  "error": {
    "code": "validation_failed",
    "message": "Request failed validation",
    "details": [{ "path": "records.0.title", "message": "Required" }],
    "requestId": "..."
  }
}`}
        </pre>
        <p className="mt-2 text-xs leading-5 text-muted">
          Branch on <code className="font-mono">code</code>, never on the message. Quote{" "}
          <code className="font-mono">requestId</code> when reporting a failure — it matches the
          server log.
        </p>
      </section>
    </div>
  );
}

function EndpointTable({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{title}</h2>
      <div className="overflow-hidden rounded-card border border-line">
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-line">
            {rows.map(([endpoint, description]) => (
              <tr key={endpoint} className="align-top">
                <td className="whitespace-nowrap bg-raised px-3 py-2.5 font-mono text-xs text-fg">
                  {endpoint}
                </td>
                <td className="px-3 py-2.5 text-xs leading-5 text-muted">{description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
