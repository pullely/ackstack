import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { AcknowledgmentView, PoliciesRepository, RoundsRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createPoliciesRepository, createRoundsRepository } from "@saas/db/policies";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { errorResponse } from "../http.js";
import { versionPublicId } from "../ids.js";
import { slugify } from "../public.js";

/**
 * The two CSV exports an auditor asks for. Every acknowledgment row names the
 * exact version, the timestamp and the IP it was recorded from.
 */

export interface HandleExportDeps {
  policiesRepo?: PoliciesRepository;
  roundsRepo?: RoundsRepository;
}

/** RFC 4180 quoting, plus a leading-apostrophe guard against spreadsheet formula injection. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function csvResponse(body: string, filename: string, requestId: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-request-id": requestId,
    },
  });
}

const HEADER = [
  "staff_name",
  "staff_email",
  "work_state",
  "location",
  "role",
  "policy",
  "version",
  "version_id",
  "status",
  "sent_at",
  "acknowledged_at",
  "ack_ip",
  "superseded_at",
];

function row(a: AcknowledgmentView): unknown[] {
  return [
    a.staffName,
    a.staffEmail,
    a.staffWorkState,
    a.staffLocation,
    a.staffRole,
    a.policyTitle,
    a.version,
    versionPublicId(a.versionId),
    a.status,
    a.sentAt,
    a.acknowledgedAt,
    a.ackIp,
    a.supersededAt,
  ];
}

/**
 * GET /v1/organizations/{org}/policies/{pol}/export — one row per member of
 * staff who was ever asked: their most recent acknowledgment if they have
 * one, otherwise their most recent request.
 */
export async function handleExportPolicy(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  policyId: Uuid,
  deps?: HandleExportDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.read");
  if (!guard.ok) return guard.response;
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const policies = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const policy = await policies.getPolicyById(orgId, policyId);
    if (!policy.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const all = await rounds.listAllAcknowledgments(orgId, { policyId });
    if (!all.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    // Newest first, so the first acknowledged row per staff wins, else the first row.
    const best = new Map<string, AcknowledgmentView>();
    for (const a of all.value) {
      const current = best.get(a.staffId);
      if (!current) best.set(a.staffId, a);
      else if (current.status !== "acknowledged" && a.status === "acknowledged") best.set(a.staffId, a);
    }
    const rows = [...best.values()]
      .sort((x, y) => x.staffName.localeCompare(y.staffName))
      .map(row);
    return csvResponse(toCsv(HEADER, rows), `${slugify(policy.value.title) || "policy"}-acknowledgments.csv`, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

/** GET /v1/organizations/{org}/staff/{stf}/export — one row per acknowledgment request, newest first. */
export async function handleExportStaff(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  staffId: Uuid,
  deps?: HandleExportDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.staff.read");
  if (!guard.ok) return guard.response;
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const policies = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const staff = await policies.getStaffById(orgId, staffId);
    if (!staff.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const all = await rounds.listAllAcknowledgments(orgId, { staffId });
    if (!all.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return csvResponse(
      toCsv(HEADER, all.value.map(row)),
      `${slugify(staff.value.fullName) || "staff"}-acknowledgments.csv`,
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
