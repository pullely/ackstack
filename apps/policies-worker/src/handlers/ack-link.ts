import type { Env } from "../env.js";
import type { AckLinkView, RoundsRepository } from "@saas/db/policies";
import { createRoundsRepository } from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { successResponse, errorResponse } from "../http.js";
import {
  acknowledgmentPublicId,
  assignmentPublicId,
  orgPublicId,
  policyPublicId,
  staffPublicId,
  versionPublicId,
} from "../ids.js";
import { hashToken, isWellFormedToken } from "../tokens.js";

/**
 * The public lane: a member of staff holding a link. No session, no login —
 * the token is the whole identity story (risk AS-B). Every failure is the same
 * `404 ack_link_invalid`, never a hint about which of unknown, expired or
 * superseded it was.
 */

export interface HandleAckDeps {
  roundsRepo?: RoundsRepository;
  eventsRepo?: EventsRepository;
  now?: Date;
}

function invalid(requestId: string): Response {
  return errorResponse("not_found", "This link is not valid", 404, requestId, {
    reason: "ack_link_invalid",
  });
}

/** A link is usable while pending and unexpired; an acknowledged one still shows its receipt. */
function usable(view: AckLinkView, now: Date): boolean {
  const ack = view.acknowledgment;
  if (ack.status === "acknowledged") return true;
  return ack.status === "pending" && ack.expiresAt.getTime() > now.getTime();
}

async function load(
  env: Env,
  token: string,
  now: Date,
  rounds: RoundsRepository,
): Promise<AckLinkView | null> {
  if (!isWellFormedToken(token)) return null;
  const found = await rounds.findByTokenHash(await hashToken(token));
  if (!found.ok) return null;
  return usable(found.value, now) ? found.value : null;
}

/** GET /v1/ack/{token} */
export async function handleGetAckLink(
  env: Env,
  requestId: string,
  token: string,
  deps?: HandleAckDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB && !deps?.roundsRepo) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const view = await load(env, token, deps?.now ?? new Date(), rounds);
    if (!view) return invalid(requestId);
    return successResponse(
      {
        policy: { title: view.policyTitle, category: view.policyCategory },
        version: {
          version: view.version,
          bodyMd: view.bodyMd,
          summary: view.summary,
          hasDocument: !!view.objectKey,
          filename: view.filename,
        },
        staff: { fullName: view.staffName },
        status: view.acknowledgment.status,
        acknowledgedAt: view.acknowledgment.acknowledgedAt
          ? view.acknowledgment.acknowledgedAt.toISOString()
          : null,
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

/**
 * GET /v1/ack/{token}/document — the exact bytes of the version the
 * acknowledgment names, never the policy's current version.
 */
export async function handleGetAckDocument(
  env: Env,
  requestId: string,
  token: string,
  deps?: HandleAckDeps,
): Promise<Response> {
  if (!env.POLICY_DOCS || (!env.PLATFORM_DB && !deps?.roundsRepo)) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const view = await load(env, token, deps?.now ?? new Date(), rounds);
    if (!view || !view.objectKey) return invalid(requestId);
    const object = await env.POLICY_DOCS.get(view.objectKey);
    if (!object) return invalid(requestId);
    const headers = new Headers();
    headers.set("content-type", view.contentType ?? "application/octet-stream");
    headers.set("x-request-id", requestId);
    headers.set("cache-control", "private, no-store");
    if (view.sha256) headers.set("etag", `"${view.sha256}"`);
    if (view.filename) {
      headers.set("content-disposition", `inline; filename="${view.filename.replace(/["\\]/g, "")}"`);
    }
    return new Response(object.body, { status: 200, headers });
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

/** POST /v1/ack/{token} — records the acknowledgment once; 409 after. */
export async function handlePostAckLink(
  request: Request,
  env: Env,
  requestId: string,
  token: string,
  deps?: HandleAckDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB && !deps?.roundsRepo) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!isWellFormedToken(token)) return invalid(requestId);
  const now = deps?.now ?? new Date();
  // api-edge copies the caller's CF-Connecting-IP and User-Agent onto these;
  // this worker is reachable only over the service binding.
  const ip = request.headers.get("x-client-ip");
  const userAgent = (request.headers.get("x-client-user-agent") ?? "").slice(0, 400) || null;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const rounds = deps?.roundsRepo ?? createRoundsRepository(executor);
    const tokenHash = await hashToken(token);
    const outcome = await rounds.recordAcknowledgment(tokenHash, now, ip, userAgent);
    if (!outcome.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    if (outcome.value.kind === "invalid") return invalid(requestId);
    if (outcome.value.kind === "already_recorded") {
      return errorResponse("conflict", "This acknowledgment is already recorded", 409, requestId, {
        reason: "ack_already_recorded",
        acknowledgedAt: outcome.value.acknowledgment.acknowledgedAt?.toISOString() ?? null,
      });
    }

    const ack = outcome.value.acknowledgment;
    const view = await rounds.findByTokenHash(tokenHash);
    const title = view.ok ? view.value.policyTitle : "";
    const version = view.ok ? view.value.version : 0;
    const staffName = view.ok ? view.value.staffName : "";

    const events = deps?.eventsRepo ?? createEventsRepository(executor);
    await events.appendEventWithAudit({
      event: {
        id: crypto.randomUUID(),
        type: "acknowledgment.recorded",
        version: 1,
        source: "policies-worker",
        occurredAt: now,
        actorType: "staff",
        actorId: staffPublicId(ack.staffId),
        orgId: ack.orgId,
        subjectKind: "acknowledgment",
        subjectId: ack.id,
        subjectName: `${staffName} — ${title} v${version}`,
        requestId,
        payload: {
          orgId: orgPublicId(ack.orgId),
          acknowledgmentId: acknowledgmentPublicId(ack.id),
          assignmentId: assignmentPublicId(ack.assignmentId),
          policyId: policyPublicId(ack.policyId),
          versionId: versionPublicId(ack.versionId),
          version,
          staffId: staffPublicId(ack.staffId),
          acknowledgedAt: now.toISOString(),
          ip,
        },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "policies",
        description: `${staffName} acknowledged "${title}" version ${version}`,
      },
    });

    return successResponse(
      {
        receipt: {
          policyTitle: title,
          version,
          acknowledgedAt: (ack.acknowledgedAt ?? now).toISOString(),
          staffName,
        },
      },
      requestId,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
