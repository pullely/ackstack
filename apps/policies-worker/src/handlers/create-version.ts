import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createPoliciesRepository } from "@saas/db/policies";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { toPublicVersion } from "../public.js";

const BODY_MAX = 500_000;
const SUMMARY_MAX = 2_000;

export interface HandleCreateVersionDeps {
  policiesRepo?: PoliciesRepository;
}

/**
 * Drafts the next version of a policy.
 *
 * A version is created empty-ish and sealed later by `/publish`, because the
 * document travels as a body of its own through `PUT .../document` — a PDF
 * does not belong base64-encoded inside a JSON envelope.
 */
export async function handleCreateVersion(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  policyId: Uuid,
  deps?: HandleCreateVersionDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.write");
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const input = (body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string[]> = {};

  const bodyMd = typeof input.bodyMd === "string" ? input.bodyMd : null;
  if (bodyMd !== null && bodyMd.length > BODY_MAX) {
    fields.bodyMd = [`must be at most ${BODY_MAX} characters`];
  }
  const summary = typeof input.summary === "string" ? input.summary : null;
  if (summary !== null && summary.length > SUMMARY_MAX) {
    fields.summary = [`must be at most ${SUMMARY_MAX} characters`];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const result = await repo.createVersion({
      id: crypto.randomUUID(),
      orgId,
      policyId,
      bodyMd,
      summary,
      createdAt: new Date(),
    });
    if (!result.ok) {
      if (result.error.kind === "not_found") {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
      if (result.error.kind === "conflict") {
        return errorResponse(
          "conflict",
          "Another version was created at the same moment; retry",
          409,
          requestId,
        );
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    return successResponse({ version: toPublicVersion(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
