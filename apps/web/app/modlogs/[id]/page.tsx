import { notFound, permanentRedirect } from "next/navigation";
import { ID_PATTERN, normalizeId, subjectArchivePath } from "@archive/shared";
import { api } from "@/lib/api";

/**
 * Flat-id convenience route.
 *
 * The canonical URL for a record includes its subject
 * (/roblox-modlogs/:accountId/:logId, or the Discord equivalent), but audit
 * entries and API responses often carry only the record id. This resolves the
 * subject and redirects, so there is exactly one indexable address per record.
 */
export default async function ModlogRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = normalizeId(raw);
  if (!ID_PATTERN.test(id)) notFound();

  // A 404 from the API calls notFound() itself, so no catch is needed here -
  // and catching would swallow Next's redirect/not-found control flow.
  const { modlog } = await api.modlogById(id);
  // The subject's platform decides the path: a Discord record redirected to
  // /roblox-modlogs/<snowflake> would 404 against an account that isn't there.
  permanentRedirect(`${subjectArchivePath(modlog.platform, modlog.externalId)}/${modlog.id}`);
}
