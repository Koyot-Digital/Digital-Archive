import { and, desc, eq, sql as raw } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import { logger } from "../lib/logger.js";

/**
 * The moderation audit trail.
 *
 * Append-only by database rule (see 0001_init.sql). Writes are intentionally
 * non-throwing: failing to log must never roll back the action that was
 * already performed, but it must be loud in the service logs.
 */

export interface AuditEntry {
  actorType: "user" | "api_key" | "system";
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel?.slice(0, 128) ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
      ip: entry.ip ?? null,
      userAgent: entry.userAgent?.slice(0, 512) ?? null,
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, action: entry.action },
      "failed to write audit entry",
    );
  }
}

/** Batch variant — one statement for a whole ingest run. */
export async function recordAuditMany(entries: AuditEntry[]): Promise<void> {
  if (!entries.length) return;
  try {
    await db.insert(auditLog).values(
      entries.map((entry) => ({
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        actorLabel: entry.actorLabel?.slice(0, 128) ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ?? {},
        ip: entry.ip ?? null,
        userAgent: entry.userAgent?.slice(0, 512) ?? null,
      })),
    );
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "failed to write audit batch");
  }
}

export interface AuditPage {
  entries: {
    id: number;
    actorType: string;
    actorId: string | null;
    actorLabel: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
  }[];
  total: number;
  page: number;
  limit: number;
}

export async function listAudit(opts: {
  page: number;
  limit: number;
  action?: string | undefined;
  actorId?: string | undefined;
  targetId?: string | undefined;
}): Promise<AuditPage> {
  const filters = [
    opts.action ? eq(auditLog.action, opts.action) : undefined,
    opts.actorId ? eq(auditLog.actorId, opts.actorId) : undefined,
    opts.targetId ? eq(auditLog.targetId, opts.targetId) : undefined,
  ].filter(Boolean);
  const where = filters.length ? and(...(filters as never[])) : undefined;

  const [rows, counted] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        actorLabel: auditLog.actorLabel,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(opts.limit)
      .offset((opts.page - 1) * opts.limit),
    db
      .select({ total: raw<number>`count(*)::int` })
      .from(auditLog)
      .where(where)
      .then((r) => r[0]?.total ?? 0),
  ]);

  return { entries: rows, total: counted, page: opts.page, limit: opts.limit };
}
