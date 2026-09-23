/**
 * Policy acknowledgments (AS) — the wire shapes.
 *
 * Every timestamp is an ISO string and every id is a public id
 * (`pol_`, `pov_`, `stf_`), never a UUID. Responses here are the INNER `data`
 * payload; the `{ data, meta }` envelope is added by the worker's http layer.
 */

export const POLICY_CATEGORIES = [
  "handbook",
  "harassment",
  "workplace_violence",
  "safety",
  "other",
] as const;

export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export const POLICY_STATUSES = ["draft", "active", "retired"] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export const STAFF_STATUSES = ["active", "inactive"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/** Content types a policy document may be uploaded as. */
export const POLICY_DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
] as const;

/** The upload ceiling, in bytes. A handbook is prose, not a video. */
export const POLICY_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

export interface PublicPolicy {
  id: string;
  orgId: string;
  title: string;
  slug: string;
  category: PolicyCategory;
  status: PolicyStatus;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}

export interface PublicPolicyVersion {
  id: string;
  orgId: string;
  policyId: string;
  version: number;
  hasDocument: boolean;
  contentType: string | null;
  byteSize: number | null;
  sha256: string | null;
  filename: string | null;
  bodyMd: string | null;
  summary: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface PublicStaffMember {
  id: string;
  orgId: string;
  fullName: string;
  email: string;
  workState: string | null;
  location: string | null;
  role: string | null;
  status: StaffStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePolicyRequest {
  title: string;
  slug?: string;
  category?: PolicyCategory;
}

export interface CreatePolicyResponse {
  policy: PublicPolicy;
}

export interface GetPolicyResponse {
  policy: PublicPolicy;
}

export interface ListPoliciesResponse {
  policies: PublicPolicy[];
}

export interface UpdatePolicyRequest {
  title?: string;
  category?: PolicyCategory;
  status?: PolicyStatus;
}

export interface UpdatePolicyResponse {
  policy: PublicPolicy;
}

export interface CreatePolicyVersionRequest {
  bodyMd?: string;
  summary?: string;
}

export interface CreatePolicyVersionResponse {
  version: PublicPolicyVersion;
}

export interface ListPolicyVersionsResponse {
  versions: PublicPolicyVersion[];
}

export interface GetPolicyVersionResponse {
  version: PublicPolicyVersion;
}

export interface PublishPolicyVersionResponse {
  version: PublicPolicyVersion;
  policy: PublicPolicy;
}

export interface AttachPolicyDocumentResponse {
  version: PublicPolicyVersion;
}

export interface StaffInput {
  fullName: string;
  email: string;
  workState?: string | null;
  location?: string | null;
  role?: string | null;
}

export interface CreateStaffRequest extends Partial<StaffInput> {
  /** A roster upload: many at once, idempotent on email within the org. */
  staff?: StaffInput[];
}

export interface CreateStaffResponse {
  staff: PublicStaffMember[];
}

export interface GetStaffResponse {
  staff: PublicStaffMember;
}

export interface ListStaffResponse {
  staff: PublicStaffMember[];
}

export interface UpdateStaffResponse {
  staff: PublicStaffMember;
}
