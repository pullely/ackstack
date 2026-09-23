export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";

export type PoliciesRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "immutable"; entity: string }
  | { kind: "internal"; message: string };

export type PoliciesResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PoliciesRepositoryError };

export interface Policy {
  id: string;
  orgId: string;
  title: string;
  slug: string;
  slugLower: string;
  category: string;
  status: string;
  currentVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  retiredAt: Date | null;
}

export interface PolicyVersion {
  id: string;
  orgId: string;
  policyId: string;
  version: number;
  objectKey: string | null;
  contentType: string | null;
  byteSize: number | null;
  sha256: string | null;
  filename: string | null;
  bodyMd: string | null;
  summary: string | null;
  publishedAt: Date | null;
  publishedBy: string | null;
  createdAt: Date;
}

export interface StaffMember {
  id: string;
  orgId: string;
  fullName: string;
  email: string;
  emailLower: string;
  workState: string | null;
  location: string | null;
  role: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePolicyInput {
  id: string;
  orgId: Uuid;
  title: string;
  slug: string;
  slugLower: string;
  category: string;
  createdAt: Date;
}

export interface UpdatePolicyInput {
  title?: string;
  category?: string;
  status?: string;
}

export interface CreateVersionInput {
  id: string;
  orgId: Uuid;
  policyId: Uuid;
  bodyMd: string | null;
  summary: string | null;
  createdAt: Date;
}

/** What `PUT .../document` records once the bytes are in R2. */
export interface AttachDocumentInput {
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  filename: string;
}

export interface UpsertStaffInput {
  id: string;
  orgId: Uuid;
  fullName: string;
  email: string;
  emailLower: string;
  workState: string | null;
  location: string | null;
  role: string | null;
  createdAt: Date;
}

export interface StaffFilter {
  workState?: string;
  location?: string;
  role?: string;
  status?: string;
}

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

export interface PoliciesRepository {
  createPolicy(input: CreatePolicyInput): Promise<PoliciesResult<Policy>>;
  getPolicyById(orgId: Uuid, policyId: Uuid): Promise<PoliciesResult<Policy>>;
  listPoliciesPaged(
    orgId: Uuid,
    params: PageQueryParams,
    filter?: { status?: string; category?: string },
  ): Promise<PoliciesResult<PagedResult<Policy>>>;
  updatePolicy(
    orgId: Uuid,
    policyId: Uuid,
    input: UpdatePolicyInput,
    updatedAt: Date,
  ): Promise<PoliciesResult<Policy>>;

  createVersion(input: CreateVersionInput): Promise<PoliciesResult<PolicyVersion>>;
  getVersionById(orgId: Uuid, versionId: Uuid): Promise<PoliciesResult<PolicyVersion>>;
  listVersions(orgId: Uuid, policyId: Uuid): Promise<PoliciesResult<PolicyVersion[]>>;
  attachDocument(
    orgId: Uuid,
    versionId: Uuid,
    input: AttachDocumentInput,
  ): Promise<PoliciesResult<PolicyVersion>>;
  publishVersion(
    orgId: Uuid,
    versionId: Uuid,
    publishedBy: string,
    publishedAt: Date,
  ): Promise<PoliciesResult<PolicyVersion>>;

  upsertStaff(input: UpsertStaffInput): Promise<PoliciesResult<StaffMember>>;
  getStaffById(orgId: Uuid, staffId: Uuid): Promise<PoliciesResult<StaffMember>>;
  listStaffPaged(
    orgId: Uuid,
    params: PageQueryParams,
    filter?: StaffFilter,
  ): Promise<PoliciesResult<PagedResult<StaffMember>>>;
  setStaffStatus(
    orgId: Uuid,
    staffId: Uuid,
    status: string,
    updatedAt: Date,
  ): Promise<PoliciesResult<StaffMember>>;
}
