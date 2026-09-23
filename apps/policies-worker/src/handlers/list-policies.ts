import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createPoliciesRepository } from "@saas/db/policies";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { errorResponse, validationError } from "../http.js";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { toPublicPolicy } from "../public.js";

export interface HandleListPoliciesDeps {
  policiesRepo?: PoliciesRepository;
}

export async function handleListPolicies(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleListPoliciesDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.read");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const page = parsePageParams(url);
  if (!page.ok) return validationError(requestId, { [page.field]: [page.reason] });

  const status = url.searchParams.get("status") ?? undefined;
  const category = url.searchParams.get("category") ?? undefined;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const result = await repo.listPoliciesPaged(
      orgId,
      {
        limit: page.value.limit,
        cursor: page.value.cursor
          ? { createdAt: page.value.cursor.createdAt, id: page.value.cursor.id }
          : null,
      },
      { ...(status ? { status } : {}), ...(category ? { category } : {}) },
    );
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const policies = result.value.items.map(toPublicPolicy);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return Response.json(
      { data: { policies }, meta: { requestId, cursor: nextCursor } },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
