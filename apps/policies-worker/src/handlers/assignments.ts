import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { RoundsRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createRoundsRepository } from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { encodeCursor, parsePageParams } from "../pagination.js";
import {
  assignmentPublicId,
  orgPublicId,
  parsePolicyPublicId,
  parseStaffPublicId,
} from "../ids.js";
import { toPublicAcknowledgment, toPublicAssignment } from "../public.js";
import { isDebugDelivery, resend, type Enqueue } from "../rounds.js";

export interface HandleAssignmentsDeps {
  roundsRepo?: RoundsRepository;
  eventsRepo?: EventsRepository;
  enqueue?: Enqueue;
  now?: Date;
}

/** GET /v1/organizations/{org}/assignments?policyId=&status=&cursor= */
export async function handleListAssignments(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleAssignmentsDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.read");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const page = parsePageParams(url);
  if (!page.ok) return validationError(requestId, { [page.field]: [page.reason] });
  const filter: { policyId?: string; status?: string } = {};
  const policyParam = url.searchParams.get("policyId");
  if (policyParam) {
    const policyId = parsePolicyPublicId(policyParam);
    if (!policyId) return validationError(requestId, { policyId: ["Must be a pol_ id"] });
    filter.policyId = policyId;
  }
  const status = url.searchParams.get("status");
  if (status) filter.status = status;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const result = await rounds.listAssignmentsPaged(
      orgId,
      {
        limit: page.value.limit,
        cursor: page.value.cursor
          ? { createdAt: page.value.cursor.createdAt, id: page.value.cursor.id }
          : null,
      },
      filter,
    );
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;
    return Response.json(
      {
        data: { assignments: result.value.items.map(toPublicAssignment) },
        meta: { requestId, cursor: nextCursor },
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

/** GET /v1/organizations/{org}/assignments/{asg} — the round, its tally and every recipient. */
export async function handleGetAssignment(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  assignmentId: Uuid,
  deps?: HandleAssignmentsDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.read");
  if (!guard.ok) return guard.response;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const assignment = await rounds.getAssignment(orgId, assignmentId);
    if (!assignment.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const tally = await rounds.tally(orgId, assignmentId);
    const acks = await rounds.listForAssignment(orgId, assignmentId);
    if (!tally.ok || !acks.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse(
      {
        assignment: toPublicAssignment(assignment.value),
        tally: tally.value,
        acknowledgments: acks.value.map(toPublicAcknowledgment),
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

/** POST /v1/organizations/{org}/assignments/{asg}/remind — re-send to everyone still pending. */
export async function handleRemindAssignment(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  assignmentId: Uuid,
  deps?: HandleAssignmentsDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.write");
  if (!guard.ok) return guard.response;

  const now = deps?.now ?? new Date();
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const events = deps?.eventsRepo ?? createEventsRepository(executor);
    const assignment = await rounds.getAssignment(orgId, assignmentId);
    if (!assignment.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const pending = await rounds.listForAssignment(orgId, assignmentId, "pending");
    if (!pending.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const result = await resend(
      {
        env,
        requestId,
        now,
        rounds,
        events,
        actor,
        ...(deps?.enqueue ? { enqueue: deps.enqueue } : {}),
      },
      pending.value,
      "policy.acknowledgment_reminder",
    );
    if (result.sent.length > 0) await rounds.markSent(orgId, result.sent, now);

    await events.appendEventWithAudit({
      event: {
        id: crypto.randomUUID(),
        type: "assignment.reminded",
        version: 1,
        source: "policies-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        subjectKind: "assignment",
        subjectId: assignmentId,
        subjectName: assignmentPublicId(assignmentId),
        requestId,
        payload: {
          orgId: orgPublicId(orgId),
          assignmentId: assignmentPublicId(assignmentId),
          reminded: result.sent.length,
          pending: pending.value.length,
        },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "policies",
        description: `Reminded ${result.sent.length} member(s) of staff still pending`,
      },
    });

    return successResponse(
      {
        reminded: result.sent.length,
        ...(isDebugDelivery(env) ? { debugLinks: result.links } : {}),
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

/** GET /v1/organizations/{org}/acknowledgments?policyId=&staffId=&status=&cursor= */
export async function handleListAcknowledgments(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleAssignmentsDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.read");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const page = parsePageParams(url);
  if (!page.ok) return validationError(requestId, { [page.field]: [page.reason] });
  const filter: { policyId?: string; staffId?: string; status?: string } = {};
  const policyParam = url.searchParams.get("policyId");
  if (policyParam) {
    const policyId = parsePolicyPublicId(policyParam);
    if (!policyId) return validationError(requestId, { policyId: ["Must be a pol_ id"] });
    filter.policyId = policyId;
  }
  const staffParam = url.searchParams.get("staffId");
  if (staffParam) {
    const staffId = parseStaffPublicId(staffParam);
    if (!staffId) return validationError(requestId, { staffId: ["Must be a stf_ id"] });
    filter.staffId = staffId;
  }
  const status = url.searchParams.get("status");
  if (status) filter.status = status;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const result = await rounds.listAcknowledgmentsPaged(
      orgId,
      {
        limit: page.value.limit,
        cursor: page.value.cursor
          ? { createdAt: page.value.cursor.createdAt, id: page.value.cursor.id }
          : null,
      },
      filter,
    );
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;
    return Response.json(
      {
        data: { acknowledgments: result.value.items.map(toPublicAcknowledgment) },
        meta: { requestId, cursor: nextCursor },
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
