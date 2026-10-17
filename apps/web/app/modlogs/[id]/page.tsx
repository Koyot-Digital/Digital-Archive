import { notFound, permanentRedirect } from "next/navigation";
import { ID_PATTERN, normalizeId } from "@archive/shared";
import { api } from "@/lib/api";

/**
 * Flat-id convenience route.
 *
 * The canonical URL for a record includes its subject
 * (/roblox-modlogs/:robloxId/:logId), but audit entries and API responses
 * often carry only the record id. This resolves the subject and redirects, so
 * there is exactly one indexable address per record.
 */
export default async function ModlogRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = normalizeId(raw);
  if (!ID_PATTERN.test(id)) notFound();

  // A 404 from the API calls notFound() itself, so no catch is needed here —
  // and catching would swallow Next's redirect/not-found control flow.
  const { modlog } = await api.modlogById(id);
  permanentRedirect(`/roblox-modlogs/${modlog.robloxId}/${modlog.id}`);
}
