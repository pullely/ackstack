# cloudflare-r2

Provisions the R2 bucket that holds policy documents, one per environment
(`ackstack-policy-docs-stage`, `ackstack-policy-docs-prod`).

The bucket is private. Nothing reads it directly: `apps/policies-worker` binds
it as `POLICY_DOCS` and is the only reader, authorizing each read either by an
organization membership (an administrator reading the register) or by an
acknowledgment link token (a member of staff reading the policy they are being
asked to acknowledge).

Objects are keyed `orgs/{org_id}/policies/{pol_…}/{pov_…}` and are written
exactly once. A policy is corrected by publishing a new version with a new key,
never by overwriting an object — the acknowledgment row names a `pov_`, and the
bytes behind that `pov_` must never change after someone has signed for them.

The apply publishes `WIRING_CLOUDFLARE_R2` on the project's environment rung;
`policies-worker` reads it back as `WIRING_CLOUDFLARE_R2_<ENV>` and resolves
`@@wiring(cloudflare-r2/<env>:policy_docs_bucket_name)@@` in its wrangler
template. No bucket name is ever committed.
