import type {
  AttachPolicyDocumentResponse,
  CreatePolicyRequest,
  CreatePolicyResponse,
  CreatePolicyVersionRequest,
  CreatePolicyVersionResponse,
  CreateStaffRequest,
  CreateStaffResponse,
  GetPolicyResponse,
  GetPolicyVersionResponse,
  GetStaffResponse,
  ListPoliciesResponse,
  ListPolicyVersionsResponse,
  ListStaffResponse,
  PublishPolicyVersionResponse,
  UpdatePolicyRequest,
  UpdatePolicyResponse,
  UpdateStaffResponse,
} from "@saas/contracts/policies";

import type { Transport, RequestOptions } from "./transport.js";

const seg = encodeURIComponent;

/**
 * Policy acknowledgments resource client.
 *
 * Org-scoped: every method takes `orgId` as the first argument.
 * Maps to `apps/policies-worker` via the api-edge `policies-facade` route.
 */
export class PoliciesClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/policies */
  list(orgId: string, opts: RequestOptions = {}): Promise<ListPoliciesResponse> {
    return this.transport.request<ListPoliciesResponse>(
      { method: "GET", path: `/v1/organizations/${seg(orgId)}/policies` },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/policies */
  create(
    orgId: string,
    body: CreatePolicyRequest,
    opts: RequestOptions = {},
  ): Promise<CreatePolicyResponse> {
    return this.transport.request<CreatePolicyResponse>(
      { method: "POST", path: `/v1/organizations/${seg(orgId)}/policies`, body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/policies/:policyId */
  get(orgId: string, policyId: string, opts: RequestOptions = {}): Promise<GetPolicyResponse> {
    return this.transport.request<GetPolicyResponse>(
      { method: "GET", path: `/v1/organizations/${seg(orgId)}/policies/${seg(policyId)}` },
      opts,
    );
  }

  /** PATCH /v1/organizations/:orgId/policies/:policyId */
  update(
    orgId: string,
    policyId: string,
    body: UpdatePolicyRequest,
    opts: RequestOptions = {},
  ): Promise<UpdatePolicyResponse> {
    return this.transport.request<UpdatePolicyResponse>(
      {
        method: "PATCH",
        path: `/v1/organizations/${seg(orgId)}/policies/${seg(policyId)}`,
        body,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/policies/:policyId/versions */
  listVersions(
    orgId: string,
    policyId: string,
    opts: RequestOptions = {},
  ): Promise<ListPolicyVersionsResponse> {
    return this.transport.request<ListPolicyVersionsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${seg(orgId)}/policies/${seg(policyId)}/versions`,
      },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/policies/:policyId/versions */
  createVersion(
    orgId: string,
    policyId: string,
    body: CreatePolicyVersionRequest,
    opts: RequestOptions = {},
  ): Promise<CreatePolicyVersionResponse> {
    return this.transport.request<CreatePolicyVersionResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${seg(orgId)}/policies/${seg(policyId)}/versions`,
        body,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/policies/:policyId/versions/:versionId */
  getVersion(
    orgId: string,
    policyId: string,
    versionId: string,
    opts: RequestOptions = {},
  ): Promise<GetPolicyVersionResponse> {
    return this.transport.request<GetPolicyVersionResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${seg(orgId)}/policies/${seg(policyId)}/versions/${seg(versionId)}`,
      },
      opts,
    );
  }

  /**
   * PUT /v1/organizations/:orgId/policies/:policyId/versions/:versionId/document
   *
   * The document travels as the raw body, not as JSON: `contentType` becomes
   * the request's own content type and `filename` rides on
   * `x-document-filename`.
   */
  putDocument(
    orgId: string,
    policyId: string,
    versionId: string,
    document: ArrayBuffer | Blob,
    contentType: string,
    filename: string,
    opts: RequestOptions = {},
  ): Promise<AttachPolicyDocumentResponse> {
    return this.transport.request<AttachPolicyDocumentResponse>(
      {
        method: "PUT",
        path: `/v1/organizations/${seg(orgId)}/policies/${seg(policyId)}/versions/${seg(versionId)}/document`,
        rawBody: document,
        headers: {
          "content-type": contentType,
          "x-document-filename": filename,
        },
      },
      opts,
    );
  }

  /** The URL a document is read back from; an authorized GET streams the bytes. */
  documentPath(orgId: string, policyId: string, versionId: string): string {
    return `/v1/organizations/${seg(orgId)}/policies/${seg(policyId)}/versions/${seg(versionId)}/document`;
  }

  /** POST /v1/organizations/:orgId/policies/:policyId/versions/:versionId/publish */
  publishVersion(
    orgId: string,
    policyId: string,
    versionId: string,
    opts: RequestOptions = {},
  ): Promise<PublishPolicyVersionResponse> {
    return this.transport.request<PublishPolicyVersionResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${seg(orgId)}/policies/${seg(policyId)}/versions/${seg(versionId)}/publish`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/staff */
  listStaff(orgId: string, opts: RequestOptions = {}): Promise<ListStaffResponse> {
    return this.transport.request<ListStaffResponse>(
      { method: "GET", path: `/v1/organizations/${seg(orgId)}/staff` },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/staff — one member, or a whole roster. */
  createStaff(
    orgId: string,
    body: CreateStaffRequest,
    opts: RequestOptions = {},
  ): Promise<CreateStaffResponse> {
    return this.transport.request<CreateStaffResponse>(
      { method: "POST", path: `/v1/organizations/${seg(orgId)}/staff`, body },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/staff/:staffId */
  getStaff(orgId: string, staffId: string, opts: RequestOptions = {}): Promise<GetStaffResponse> {
    return this.transport.request<GetStaffResponse>(
      { method: "GET", path: `/v1/organizations/${seg(orgId)}/staff/${seg(staffId)}` },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/staff/:staffId — deactivates, never deletes. */
  deactivateStaff(
    orgId: string,
    staffId: string,
    opts: RequestOptions = {},
  ): Promise<UpdateStaffResponse> {
    return this.transport.request<UpdateStaffResponse>(
      { method: "DELETE", path: `/v1/organizations/${seg(orgId)}/staff/${seg(staffId)}` },
      opts,
    );
  }
}
