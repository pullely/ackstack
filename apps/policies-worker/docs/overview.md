# policies-worker

Cloudflare Worker for the policy acknowledgments runtime

Part of the ackstack runtime: a Cloudflare Worker deployed per environment (`stage`, `prod`; `dev` is verify-only). Not publicly routable — reached only through `api-edge` service bindings.

## Depends on

- **membership-worker** — Cloudflare Worker for the Membership org runtime
- **policy-worker** — Cloudflare Worker for policy authorization decisions
- **cloudflare-r2** — the private bucket holding policy documents

## Depended on by

- **api-edge** — Cloudflare Worker for the API edge Runtime

## What it owns

The `policies` bounded context: the policy register, its immutable versions,
and the staff roster those versions are sent to.

A **version** is the unit a member of staff acknowledges, and it carries two
renditions of the same policy — the uploaded document in R2 (`POLICY_DOCS`) and
a Markdown rendition in D1 that reads on a phone. Publishing is three calls,
because a PDF does not belong inside a JSON envelope:

1. `POST .../versions` drafts one and allocates its number,
2. `PUT .../versions/{pov}/document` streams the bytes into R2 and records the
   SHA-256 computed as they arrive,
3. `POST .../versions/{pov}/publish` seals it and moves the register's pointer.

After the seal the version is frozen in both renditions and the R2 object is
never overwritten. A correction is a new version — the acknowledgment row names
a `pov_`, and the bytes behind that `pov_` must not change after someone has
signed for them.

**Staff are recipients, not users.** They never authenticate, they are
deactivated rather than deleted, and a roster re-upload updates on
`(org_id, lower(email))` instead of piling up duplicates.
