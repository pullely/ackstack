import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository, StaffMember } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import type { StaffInput } from "@saas/contracts/policies";
import { createPoliciesRepository } from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId, staffPublicId } from "../ids.js";
import { toPublicStaff } from "../public.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_RE = /^[A-Z]{2}$/;
const MAX_BATCH = 500;

export interface HandleCreateStaffDeps {
  policiesRepo?: PoliciesRepository;
  eventsRepo?: EventsRepository;
}

type Normalized = Required<Pick<StaffInput, "fullName" | "email">> & {
  workState: string | null;
  location: string | null;
  role: string | null;
};

function normalize(
  raw: unknown,
  index: number,
  fields: Record<string, string[]>,
): Normalized | null {
  const input = (raw ?? {}) as Record<string, unknown>;
  const prefix = `staff[${index}]`;
  let bad = false;

  const fullName = typeof input.fullName === "string" ? input.fullName.trim() : "";
  if (fullName.length < 1 || fullName.length > 200) {
    fields[`${prefix}.fullName`] = ["must be between 1 and 200 characters"];
    bad = true;
  }
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!EMAIL_RE.test(email)) {
    fields[`${prefix}.email`] = ["must be an email address"];
    bad = true;
  }
  const workState =
    typeof input.workState === "string" && input.workState.trim()
      ? input.workState.trim().toUpperCase()
      : null;
  if (workState !== null && !STATE_RE.test(workState)) {
    fields[`${prefix}.workState`] = ["must be a two-letter US state code"];
    bad = true;
  }
  if (bad) return null;

  const location = typeof input.location === "string" && input.location.trim() ? input.location.trim() : null;
  const role = typeof input.role === "string" && input.role.trim() ? input.role.trim() : null;
  return { fullName, email, workState, location, role };
}

/**
 * Creates one member of staff, or a whole roster.
 *
 * A re-upload of the same roster is an update, not a pile of duplicates: the
 * identity of a recipient is their email within the organization, and payroll
 * exports get re-sent every time someone changes a phone number.
 */
export async function handleCreateStaff(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleCreateStaffDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.staff.write");
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const input = (body ?? {}) as Record<string, unknown>;
  const rawList = Array.isArray(input.staff) ? input.staff : [input];
  if (rawList.length === 0) {
    return validationError(requestId, { staff: ["must not be empty"] });
  }
  if (rawList.length > MAX_BATCH) {
    return validationError(requestId, { staff: [`must be at most ${MAX_BATCH} entries`] });
  }

  const fields: Record<string, string[]> = {};
  const normalized: Normalized[] = [];
  rawList.forEach((raw, index) => {
    const item = normalize(raw, index, fields);
    if (item) normalized.push(item);
  });
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const now = new Date();
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const saved: StaffMember[] = [];
    for (const item of normalized) {
      const result = await repo.upsertStaff({
        id: crypto.randomUUID(),
        orgId,
        fullName: item.fullName,
        email: item.email,
        emailLower: item.email.toLowerCase(),
        workState: item.workState,
        location: item.location,
        role: item.role,
        createdAt: now,
      });
      if (!result.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
      saved.push(result.value);
    }

    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor);
    await eventsRepo.appendEventWithAudit({
      event: {
        id: crypto.randomUUID(),
        type: "staff.upserted",
        version: 1,
        source: "policies-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        subjectKind: "staff",
        subjectId: saved[0]!.id,
        subjectName: saved.length === 1 ? saved[0]!.fullName : `${saved.length} staff`,
        requestId,
        payload: {
          orgId: orgPublicId(orgId),
          count: saved.length,
          staffIds: saved.slice(0, 25).map((s) => staffPublicId(s.id)),
        },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "policies",
        description:
          saved.length === 1
            ? `Saved staff member "${saved[0]!.fullName}"`
            : `Imported ${saved.length} staff members`,
      },
    });

    return successResponse({ staff: saved.map(toPublicStaff) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
