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

// ---------------------------------------------------------------------------
// AS2 — assignment rounds, acknowledgment requests, the public link lane
// ---------------------------------------------------------------------------

export const ASSIGNMENT_REASONS = ["initial", "new_version", "scheduled"] as const;
export type AssignmentReason = (typeof ASSIGNMENT_REASONS)[number];

export const ACKNOWLEDGMENT_STATUSES = ["pending", "acknowledged", "superseded"] as const;
export type AcknowledgmentStatus = (typeof ACKNOWLEDGMENT_STATUSES)[number];

/** Who a round is sent to. An empty (or absent) list matches everyone. */
export interface AssignmentAudience {
  states?: string[];
  locations?: string[];
  roles?: string[];
}

export interface AcknowledgmentTally {
  pending: number;
  acknowledged: number;
  superseded: number;
}

export interface PublicAssignment {
  id: string;
  orgId: string;
  policyId: string;
  versionId: string;
  reason: AssignmentReason;
  audience: Required<AssignmentAudience>;
  dueAt: string | null;
  status: "open" | "closed";
  createdAt: string;
  closedAt: string | null;
}

export interface PublicAcknowledgment {
  id: string;
  assignmentId: string;
  policyId: string;
  policyTitle: string;
  versionId: string;
  version: number;
  staffId: string;
  staffName: string;
  staffEmail: string;
  staffWorkState: string | null;
  status: AcknowledgmentStatus;
  sentAt: string | null;
  acknowledgedAt: string | null;
  ackIp: string | null;
  supersededAt: string | null;
  createdAt: string;
}

export interface CreateAssignmentRequest {
  policyId: string;
  audience?: AssignmentAudience;
  /** ISO date or timestamp; the link stays valid until 30 days after it. */
  dueAt?: string;
}

export interface CreateAssignmentResponse {
  assignment: PublicAssignment;
  tally: AcknowledgmentTally;
  /** Requests handed to the mailer in this call; the rest go out on the next sweep. */
  sent: number;
  /**
   * Only when the deployment runs with DEBUG_DELIVERY (the baseline's
   * inline-delivery profile, the same one that returns login codes inline):
   * the links that were emailed, so a stage run can be exercised end to end
   * without a mailbox.
   */
  debugLinks?: Array<{ staffId: string; link: string }>;
}

export interface ListAssignmentsResponse {
  assignments: PublicAssignment[];
}

export interface GetAssignmentResponse {
  assignment: PublicAssignment;
  tally: AcknowledgmentTally;
  acknowledgments: PublicAcknowledgment[];
}

export interface RemindAssignmentResponse {
  reminded: number;
  debugLinks?: Array<{ staffId: string; link: string }>;
}

export interface ListAcknowledgmentsResponse {
  acknowledgments: PublicAcknowledgment[];
}

/** GET /v1/ack/{token} — what a member of staff sees. No ids beyond the version number. */
export interface AckLinkResponse {
  policy: { title: string; category: PolicyCategory };
  version: {
    version: number;
    bodyMd: string | null;
    summary: string | null;
    hasDocument: boolean;
    filename: string | null;
  };
  staff: { fullName: string };
  status: AcknowledgmentStatus;
  acknowledgedAt: string | null;
}

/** POST /v1/ack/{token} — the receipt. */
export interface AckReceiptResponse {
  receipt: {
    policyTitle: string;
    version: number;
    acknowledgedAt: string;
    staffName: string;
  };
}
