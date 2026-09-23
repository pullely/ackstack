# ackstack-acknowledgments — implementation plan

Milestones land in order. Each is one or more tasks, each task one pull
request, each pull request landed with `orun pr land`. A milestone is marked
✅ here when its "done when" list is true, and recorded in
`IMPLEMENTATION-STATUS.md`.

## AS0 — the spec

This doc set, merged to `main` and attached to the epic with `orun spec push`.

**Done when**
- the five documents are on `main`
- `orun spec list --epic ackstack-acknowledgments` shows them

## AS1 — the register and the roster

The `policies` bounded context comes into existence. One D1 migration adds
`policies_policies`, `policies_versions` and `policies_staff` with their
org-scoped indexes, and one terraform component under `infra/` provisions an R2
bucket per environment whose id is published as a wiring secret, the way the
baseline already provisions D1 and KV. A new `apps/policies-worker` serves
policy CRUD, the three-step version publication (draft → `PUT` the PDF into R2
→ publish) and roster CRUD on the baseline's envelope, reusing its membership
and policy clients for authorization. `packages/contracts` gains the wire
types, `packages/sdk` the client methods, `apps/api-edge` the route table
entries and the service binding. The console gains a **Policies** section with
the register, the version history with an upload-and-publish flow, and the
roster with filters and bulk import. Nothing is sent to anybody yet — this
milestone is invisible to staff.

**Done when**
- the migration is applied on stage and prod and `packages/db` lists it
- the R2 bucket exists on stage and prod and its id resolves into the worker's
  `wrangler.jsonc` through a `@@wiring(...)@@` token, with no id committed
- `POST` then `GET /v1/organizations/{org}/policies` round-trips on both
  `https://ackstack-api-edge-stage.nexo-7be.workers.dev` and `…-prod…`
- a PDF `PUT` to `.../versions/{pov}/document` comes back byte-for-byte from
  `GET` of the same route, with the `sha256` the worker recorded on the way in
- publishing allocates version 1 then 2 and moves `current_version_id`; a
  second `PUT` to a published version is refused with `409 version_immutable`,
  and publishing a version with neither document nor body is `409 version_empty`
- a roster re-upload of the same email updates rather than duplicates
- the console shows the register, a version history and the roster
- the worker's unit tests and the repo's typecheck and lint lanes are green

## AS2 — assign, send, acknowledge

The round becomes a resource and a member of staff sees Ackstack for the first
time. A second migration adds `policies_assignments` and
`policies_acknowledgments`. Creating a round resolves the audience against the
roster, writes one acknowledgment row per match, mints a 128-bit token per row
into the `ACK_TOKENS` KV namespace keyed by its hash, and hands a batch to
`notifications-worker` behind the new `policy-acknowledgment-request` template.
`apps/api-edge` gains its first public lane: `GET` and `POST /v1/ack/{token}`,
unauthenticated, rate-limited by token and by IP, routed to the same worker.
The console Worker renders `/ack/{token}` as a page — the policy, the summary,
one button, then a receipt. Every step emits its audit event.

**Done when**
- creating an assignment for an audience of `{ states: ["NY"] }` writes exactly
  one acknowledgment row per active NY member of staff and no others
- each recipient receives the request email, and the link in it opens the
  policy without any login
- confirming writes `acknowledged_at`, the `CF-Connecting-IP` value and the
  exact `pov_` id, and returns a receipt
- replaying the same link returns `409 ack_already_recorded`, and an unknown or
  expired token returns `404 ack_link_invalid`
- `assignment.created`, `acknowledgment.sent` and `acknowledgment.recorded`
  appear in the audit trail
- the assignment detail surface shows the live tally and can remind everyone
  still pending

## AS3 — the re-collection calendar

Ackstack starts doing the thing nobody remembers to do. A third migration adds
`policies_rules`, seeded per organization with New York annual for harassment
and for workplace violence (the 2025 Retail Worker Safety Act), Illinois annual
and California two-yearly. A nightly cron trigger on `policies-worker` walks
every active policy, groups the roster by work state, finds the members of
staff whose last acknowledgment of that policy is older than the governing
rule's interval, and opens a `reason: 'scheduled'` round for exactly them.
Publishing a new version marks every still-pending acknowledgment of the
previous version `superseded` and opens a `reason: 'new_version'` round.
Finally, the compliance surface and the two CSV exports make the trail
presentable to an auditor.

**Done when**
- the cron handler runs on schedule on stage and prod and is idempotent: a
  second run on the same day opens no duplicate round
- a member of staff whose last NY harassment acknowledgment is 13 months old is
  included in the nightly round; one at 11 months is not; a California one at
  13 months is not
- publishing a new version supersedes outstanding requests for the old one and
  opens a fresh round
- `GET /v1/organizations/{org}/policies/{pol}/export` and
  `…/staff/{stf}/export` return `text/csv` naming the version, the timestamp
  and the IP of every acknowledgment
- the console shows the rule grid by state × category and lets an admin change
  an interval
- `recollection.round.opened` and `acknowledgment.superseded` appear in the
  audit trail

## Sequencing note

AS1 must land first: AS2's acknowledgment rows carry a `pov_` foreign reference,
AS2's public document route streams the R2 object AS1 uploaded, and AS2's
audience resolution reads the roster's `work_state`, `location` and `role`
columns. AS3 needs AS2's round machinery in full — the cron opens the
same kind of round through the same code path as a hand-made one, which is why
re-collection is cheap once assignment exists. Within AS1 the migration and the
worker must land together (a worker with no table fails its own health probe),
but the console surface could be split out if the diff grows past its
contract's `affects` ceiling. Nothing here is gated on a credential we do not
hold: R2 was enabled on the account on 2026-09-23 and the token verified
against the bucket API, and there is no SMS provider or model key in any of the
three milestones. The only external dependency is the baseline's existing email
sender, which AS2 is the first to use for a non-identity message.
