import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { PoliciesRepository } from "@saas/db/policies";
import type { Uuid } from "@saas/db/ids";
import { POLICY_DOCUMENT_CONTENT_TYPES, POLICY_DOCUMENT_MAX_BYTES } from "@saas/contracts/policies";
import { createPoliciesRepository } from "@saas/db/policies";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { authorize } from "../guard.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId, policyPublicId, versionPublicId } from "../ids.js";
import { toPublicVersion } from "../public.js";

export interface HandleDocumentDeps {
  policiesRepo?: PoliciesRepository;
  eventsRepo?: EventsRepository;
}

/** `orgs/{org}/policies/{pol}/{pov}` — one object, written once, never replaced. */
export function documentKey(orgId: string, policyId: string, versionId: string): string {
  return `orgs/${orgId}/policies/${policyPublicId(policyId)}/${versionPublicId(versionId)}`;
}

function hex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

export async function handlePutDocument(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  policyId: Uuid,
  versionId: Uuid,
  deps?: HandleDocumentDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.write");
  if (!guard.ok) return guard.response;
  if (!env.POLICY_DOCS) {
    return errorResponse("internal_error", "Document store unavailable", 503, requestId);
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!POLICY_DOCUMENT_CONTENT_TYPES.includes(contentType as never)) {
    return validationError(requestId, {
      "content-type": [`must be one of ${POLICY_DOCUMENT_CONTENT_TYPES.join(", ")}`],
    });
  }

  const filename = (request.headers.get("x-document-filename") ?? "policy.pdf").slice(0, 200);

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);

    // Check immutability BEFORE spending a write on R2. The repository check
    // below is still the authority — this one only saves a wasted upload.
    const existing = await repo.getVersionById(orgId, versionId);
    if (!existing.ok || existing.value.policyId !== policyId) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    if (existing.value.publishedAt) {
      return errorResponse(
        "conflict",
        "This version is published and can no longer be changed",
        409,
        requestId,
        { reason: "version_immutable" },
      );
    }

    // Buffered, not streamed: the digest has to cover exactly the bytes that
    // land in R2, and the ceiling is small enough that holding it is fine.
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) {
      return validationError(requestId, { body: ["The document is empty"] });
    }
    if (bytes.byteLength > POLICY_DOCUMENT_MAX_BYTES) {
      return errorResponse(
        "validation_failed",
        `The document is larger than ${POLICY_DOCUMENT_MAX_BYTES} bytes`,
        422,
        requestId,
      );
    }

    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    const key = documentKey(orgId, policyId, versionId);
    await env.POLICY_DOCS.put(key, bytes, {
      httpMetadata: { contentType },
      customMetadata: { orgId, sha256 },
    });

    const attached = await repo.attachDocument(orgId, versionId, {
      objectKey: key,
      contentType,
      byteSize: bytes.byteLength,
      sha256,
      filename,
    });
    if (!attached.ok) {
      if (attached.error.kind === "immutable") {
        return errorResponse(
          "conflict",
          "This version is published and can no longer be changed",
          409,
          requestId,
          { reason: "version_immutable" },
        );
      }
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const now = new Date();
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor);
    await eventsRepo.appendEventWithAudit({
      event: {
        id: crypto.randomUUID(),
        type: "policy.document.attached",
        version: 1,
        source: "policies-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        subjectKind: "policy_version",
        subjectId: versionId,
        subjectName: filename,
        requestId,
        payload: {
          orgId: orgPublicId(orgId),
          policyId: policyPublicId(policyId),
          versionId: versionPublicId(versionId),
          byteSize: bytes.byteLength,
          sha256,
        },
      },
      audit: {
        id: crypto.randomUUID(),
        category: "policies",
        description: `Attached "${filename}" to version ${attached.value.version}`,
      },
    });

    return successResponse({ version: toPublicVersion(attached.value) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

export async function handleGetDocument(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  policyId: Uuid,
  versionId: Uuid,
  deps?: HandleDocumentDeps,
): Promise<Response> {
  const guard = await authorize(env, requestId, actor, orgId, "organization.policy.read");
  if (!guard.ok) return guard.response;
  if (!env.POLICY_DOCS) {
    return errorResponse("internal_error", "Document store unavailable", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.policiesRepo ?? createPoliciesRepository(executor);
    const version = await repo.getVersionById(orgId, versionId);
    if (!version.ok || version.value.policyId !== policyId || !version.value.objectKey) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const object = await env.POLICY_DOCS.get(version.value.objectKey);
    if (!object) return errorResponse("not_found", "Not found", 404, requestId);

    const headers = new Headers();
    headers.set("content-type", version.value.contentType ?? "application/octet-stream");
    headers.set("x-request-id", requestId);
    // The digest recorded on the way in, so a caller can prove the bytes did
    // not change between the upload and the acknowledgment.
    if (version.value.sha256) headers.set("etag", `"${version.value.sha256}"`);
    if (version.value.filename) {
      headers.set(
        "content-disposition",
        `inline; filename="${version.value.filename.replace(/["\\]/g, "")}"`,
      );
    }
    return new Response(object.body, { status: 200, headers });
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}
