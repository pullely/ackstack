import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import type { PolicyCategory } from "@saas/contracts/policies";
import { POLICY_CATEGORIES } from "@saas/contracts/policies";
import { createPoliciesRepository } from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId, policyPublicId } from "../ids.js";
import { slugify, toPublicPolicy } from "../public.js";

const TITLE_MIN = 2;
const TITLE_MAX = 200;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface HandleCreatePolicyDeps {
  policiesRepo?: PoliciesRepository;
  eventsRepo?: EventsRepository;
}

interface Valid {
  valid: true;
  title: string;
  slug: string;
  category: PolicyCategory;
}

type Validation = Valid | { valid: false; fields: Record<string, string[]> };

function validateBody(body: unknown): Validation {
  const fields: Record<string, string[]> = {};
  const input = (body ?? {}) as Record<string, unknown>;

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    fields.title = [`must be between ${TITLE_MIN} and ${TITLE_MAX} characters`];
  }

  const slug = typeof input.slug === "string" && input.slug.trim() ? input.slug.trim() : slugify(title);
  if (!SLUG_RE.test(slug)) {
    fields.slug = ["must be lowercase letters, digits and hyphens"];
  }

  const category = (typeof input.category === "string" ? input.category : "other") as PolicyCategory;
  if (!POLICY_CATEGORIES.includes(category)) {
    fields.category = [`must be one of ${POLICY_CATEGORIES.join(", ")}`];
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, title, slug, category };
}

export async function handleCreatePolicy(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleCreatePolicyDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.write");
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const validation = validateBody(body);
  if (!validation.valid) return validationError(requestId, validation.fields);

  const policyId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const now = new Date();

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const result = await repo.createPolicy({
      id: policyId,
      orgId,
      title: validation.title,
      slug: validation.slug,
      slugLower: validation.slug.toLowerCase(),
      category: validation.category,
      createdAt: now,
    });

    if (!result.ok) {
      if (result.error.kind === "conflict") {
        return errorResponse(
          "conflict",
          "A policy with that slug already exists",
          409,
          requestId,
        );
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor);
    const appended = await eventsRepo.appendEventWithAudit({
      event: {
        id: eventId,
        type: "policy.created",
        version: 1,
        source: "policies-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        subjectKind: "policy",
        subjectId: policyId,
        subjectName: validation.title,
        requestId,
        payload: {
          policyId: policyPublicId(policyId),
          orgId: orgPublicId(orgId),
          title: validation.title,
          slug: validation.slug,
          category: validation.category,
        },
      },
      audit: {
        id: auditId,
        category: "policies",
        description: `Created policy "${validation.title}"`,
      },
    });
    if (!appended.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse({ policy: toPublicPolicy(result.value) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
