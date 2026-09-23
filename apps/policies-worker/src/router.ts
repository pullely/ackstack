import type { Env } from "./env.js";
import type { Uuid } from "@saas/db/ids";
import { handleHealth } from "./handlers/health.js";
import { handleCreatePolicy } from "./handlers/create-policy.js";
import { handleListPolicies } from "./handlers/list-policies.js";
import { handleGetPolicy } from "./handlers/get-policy.js";
import { handleUpdatePolicy } from "./handlers/update-policy.js";
import { handleCreateVersion } from "./handlers/create-version.js";
import { handleListVersions } from "./handlers/list-versions.js";
import { handleGetVersion } from "./handlers/get-version.js";
import { handlePutDocument, handleGetDocument } from "./handlers/version-document.js";
import { handlePublishVersion } from "./handlers/publish-version.js";
import { handleCreateStaff } from "./handlers/create-staff.js";
import { handleListStaff } from "./handlers/list-staff.js";
import { handleGetStaff } from "./handlers/get-staff.js";
import { handleDeactivateStaff } from "./handlers/deactivate-staff.js";
import { notFound, methodNotAllowed, errorResponse } from "./http.js";
import {
  generateRequestId,
  parseOrgPublicId,
  parsePolicyPublicId,
  parseStaffPublicId,
  parseVersionPublicId,
} from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

/**
 * The actor arrives as headers set by api-edge over the service binding, never
 * as a token: this worker is not reachable from the internet.
 */
function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

const ORG_POLICIES_RE = /^\/v1\/organizations\/([^/]+)\/policies$/;
const ORG_POLICY_ID_RE = /^\/v1\/organizations\/([^/]+)\/policies\/([^/]+)$/;
const ORG_POLICY_VERSIONS_RE = /^\/v1\/organizations\/([^/]+)\/policies\/([^/]+)\/versions$/;
const ORG_POLICY_VERSION_ID_RE =
  /^\/v1\/organizations\/([^/]+)\/policies\/([^/]+)\/versions\/([^/]+)$/;
const ORG_POLICY_VERSION_DOCUMENT_RE =
  /^\/v1\/organizations\/([^/]+)\/policies\/([^/]+)\/versions\/([^/]+)\/document$/;
const ORG_POLICY_VERSION_PUBLISH_RE =
  /^\/v1\/organizations\/([^/]+)\/policies\/([^/]+)\/versions\/([^/]+)\/publish$/;
const ORG_STAFF_RE = /^\/v1\/organizations\/([^/]+)\/staff$/;
const ORG_STAFF_ID_RE = /^\/v1\/organizations\/([^/]+)\/staff\/([^/]+)$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    // Longest paths first: a version's /document and /publish would otherwise
    // be swallowed by the version-id matcher.
    const documentMatch = url.pathname.match(ORG_POLICY_VERSION_DOCUMENT_RE);
    if (documentMatch) {
      const ids = decodeVersionPath(documentMatch);
      if (!ids) return notFound(requestId, url.pathname);
      const actor = resolveActor(request);
      if (!actor) return unauthenticated(requestId);
      if (request.method === "PUT") {
        return handlePutDocument(request, env, requestId, actor, ids.org, ids.policy, ids.version);
      }
      if (request.method === "GET") {
        return handleGetDocument(env, requestId, actor, ids.org, ids.policy, ids.version);
      }
      return methodNotAllowed(requestId);
    }

    const publishMatch = url.pathname.match(ORG_POLICY_VERSION_PUBLISH_RE);
    if (publishMatch) {
      const ids = decodeVersionPath(publishMatch);
      if (!ids) return notFound(requestId, url.pathname);
      if (request.method !== "POST") return methodNotAllowed(requestId);
      const actor = resolveActor(request);
      if (!actor) return unauthenticated(requestId);
      return handlePublishVersion(env, requestId, actor, ids.org, ids.policy, ids.version);
    }

    const versionIdMatch = url.pathname.match(ORG_POLICY_VERSION_ID_RE);
    if (versionIdMatch) {
      const ids = decodeVersionPath(versionIdMatch);
      if (!ids) return notFound(requestId, url.pathname);
      if (request.method !== "GET") return methodNotAllowed(requestId);
      const actor = resolveActor(request);
      if (!actor) return unauthenticated(requestId);
      return handleGetVersion(env, requestId, actor, ids.org, ids.policy, ids.version);
    }

    const versionsMatch = url.pathname.match(ORG_POLICY_VERSIONS_RE);
    if (versionsMatch) {
      const orgUuid = parseOrgPublicId(versionsMatch[1]!);
      const policyUuid = parsePolicyPublicId(versionsMatch[2]!);
      if (!orgUuid || !policyUuid) return notFound(requestId, url.pathname);
      const actor = resolveActor(request);
      if (!actor) return unauthenticated(requestId);
      if (request.method === "POST") {
        return handleCreateVersion(request, env, requestId, actor, orgUuid, policyUuid);
      }
      if (request.method === "GET") {
        return handleListVersions(env, requestId, actor, orgUuid, policyUuid);
      }
      return methodNotAllowed(requestId);
    }

    const policyIdMatch = url.pathname.match(ORG_POLICY_ID_RE);
    if (policyIdMatch) {
      const orgUuid = parseOrgPublicId(policyIdMatch[1]!);
      const policyUuid = parsePolicyPublicId(policyIdMatch[2]!);
      if (!orgUuid || !policyUuid) return notFound(requestId, url.pathname);
      const actor = resolveActor(request);
      if (!actor) return unauthenticated(requestId);
      if (request.method === "GET") {
        return handleGetPolicy(env, requestId, actor, orgUuid, policyUuid);
      }
      if (request.method === "PATCH") {
        return handleUpdatePolicy(request, env, requestId, actor, orgUuid, policyUuid);
      }
      return methodNotAllowed(requestId);
    }

    const policiesMatch = url.pathname.match(ORG_POLICIES_RE);
    if (policiesMatch) {
      const orgUuid = parseOrgPublicId(policiesMatch[1]!);
      if (!orgUuid) return notFound(requestId, url.pathname);
      const actor = resolveActor(request);
      if (!actor) return unauthenticated(requestId);
      if (request.method === "POST") {
        return handleCreatePolicy(request, env, requestId, actor, orgUuid);
      }
      if (request.method === "GET") {
        return handleListPolicies(request, env, requestId, actor, orgUuid);
      }
      return methodNotAllowed(requestId);
    }

    const staffIdMatch = url.pathname.match(ORG_STAFF_ID_RE);
    if (staffIdMatch) {
      const orgUuid = parseOrgPublicId(staffIdMatch[1]!);
      const staffUuid = parseStaffPublicId(staffIdMatch[2]!);
      if (!orgUuid || !staffUuid) return notFound(requestId, url.pathname);
      const actor = resolveActor(request);
      if (!actor) return unauthenticated(requestId);
      if (request.method === "GET") {
        return handleGetStaff(env, requestId, actor, orgUuid, staffUuid);
      }
      if (request.method === "DELETE") {
        return handleDeactivateStaff(env, requestId, actor, orgUuid, staffUuid);
      }
      return methodNotAllowed(requestId);
    }

    const staffMatch = url.pathname.match(ORG_STAFF_RE);
    if (staffMatch) {
      const orgUuid = parseOrgPublicId(staffMatch[1]!);
      if (!orgUuid) return notFound(requestId, url.pathname);
      const actor = resolveActor(request);
      if (!actor) return unauthenticated(requestId);
      if (request.method === "POST") {
        return handleCreateStaff(request, env, requestId, actor, orgUuid);
      }
      if (request.method === "GET") {
        return handleListStaff(request, env, requestId, actor, orgUuid);
      }
      return methodNotAllowed(requestId);
    }

    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}

function unauthenticated(requestId: string): Response {
  return errorResponse("unauthenticated", "Authentication required", 401, requestId);
}

function decodeVersionPath(
  match: RegExpMatchArray,
): { org: Uuid; policy: Uuid; version: Uuid } | null {
  const org = parseOrgPublicId(match[1]!);
  const policy = parsePolicyPublicId(match[2]!);
  const version = parseVersionPublicId(match[3]!);
  if (!org || !policy || !version) return null;
  return { org, policy, version };
}
