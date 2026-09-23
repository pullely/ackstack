import type { Policy, PolicyVersion, StaffMember } from "@saas/db/policies";
import type {
  PolicyCategory,
  PolicyStatus,
  PublicPolicy,
  PublicPolicyVersion,
  PublicStaffMember,
  StaffStatus,
} from "@saas/contracts/policies";
import { orgPublicId, policyPublicId, staffPublicId, versionPublicId } from "./ids.js";

export function toPublicPolicy(row: Policy): PublicPolicy {
  return {
    id: policyPublicId(row.id),
    orgId: orgPublicId(row.orgId),
    title: row.title,
    slug: row.slug,
    category: row.category as PolicyCategory,
    status: row.status as PolicyStatus,
    currentVersionId: row.currentVersionId ? versionPublicId(row.currentVersionId) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
  };
}

export function toPublicVersion(row: PolicyVersion): PublicPolicyVersion {
  return {
    id: versionPublicId(row.id),
    orgId: orgPublicId(row.orgId),
    policyId: policyPublicId(row.policyId),
    version: row.version,
    // The R2 key is never on the wire: it is an internal address, and the only
    // way to the bytes is back through this worker.
    hasDocument: !!row.objectKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    filename: row.filename,
    bodyMd: row.bodyMd,
    summary: row.summary,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPublicStaff(row: StaffMember): PublicStaffMember {
  return {
    id: staffPublicId(row.id),
    orgId: orgPublicId(row.orgId),
    fullName: row.fullName,
    email: row.email,
    workState: row.workState,
    location: row.location,
    role: row.role,
    status: row.status as StaffStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `Astoria Store Handbook` → `astoria-store-handbook`. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
