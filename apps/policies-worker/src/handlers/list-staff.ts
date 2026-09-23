import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository, StaffFilter } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { createPoliciesRepository } from "@saas/db/policies";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { errorResponse, validationError } from "../http.js";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { toPublicStaff } from "../public.js";

export interface HandleListStaffDeps {
  policiesRepo?: PoliciesRepository;
}

export async function handleListStaff(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleListStaffDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.staff.read");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const page = parsePageParams(url);
  if (!page.ok) return validationError(requestId, { [page.field]: [page.reason] });

  const filter: StaffFilter = {};
  const state = url.searchParams.get("state");
  if (state) filter.workState = state.toUpperCase();
  const location = url.searchParams.get("location");
  if (location) filter.location = location;
  const role = url.searchParams.get("role");
  if (role) filter.role = role;
  const status = url.searchParams.get("status");
  if (status) filter.status = status;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const result = await repo.listStaffPaged(
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

    const staff = result.value.items.map(toPublicStaff);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return Response.json(
      { data: { staff }, meta: { requestId, cursor: nextCursor } },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
