# ackstack-acknowledgments — design

## 1. The resource

One new bounded context, `policies`, living in `apps/policies-worker` and one
D1 migration in `packages/db/src/migrations`. Everything else in the baseline
is reused unchanged: `identity` and `membership` decide who may administer,
`events` carries the audit trail, `notifications` sends the mail, `config`
holds per-org defaults, `billing` gates the plan limits. Every table is
scoped by `org_id` and every query filters on it; there are no cross-context
foreign keys, matching the baseline's rule.

```
policy                                   policies_policies
  id            text        pol_…  , unique within org
  org_id        text        the owning organization
  title         text
  slug_lower    text        unique per org
  category      text        'handbook' | 'harassment' | 'workplace_violence' | 'safety' | 'other'
  status        text        'draft' | 'active' | 'retired'
  current_version_id text   pov_… , null until the first publish
  created_at    text
  updated_at    text

policy version                           policies_versions
  id            text        pov_…
  org_id        text
  policy_id     text        pol_…
  version       integer     1, 2, 3 … monotonic per policy
  object_key    text        R2 key, orgs/{org_id}/policies/{pol}/{pov}.pdf ; null until uploaded
  content_type  text        'application/pdf' in practice; whitelisted on upload
  byte_size     integer
  sha256        text        of the uploaded bytes, computed on the way in
  filename      text        the uploader's own filename, for the export
  body_md       text        a Markdown rendition of the same policy; nullable
  summary       text        a short plain-language summary, author-supplied
  published_at  text        set once; a published version is immutable
  published_by  text        usr_…
  created_at    text

staff member (a recipient, never a user)  policies_staff
  id            text        stf_…
  org_id        text
  full_name     text
  email         text        unique per org, lowercased
  work_state    text        two-letter US state, drives the re-collection clock
  location      text        free text, e.g. 'Astoria store'
  role          text        free text, e.g. 'shift lead'
  status        text        'active' | 'inactive'
  created_at    text
  updated_at    text

assignment round                          policies_assignments
  id            text        asg_…
  org_id        text
  policy_id     text        pol_…
  version_id    text        pov_… , the exact version being acknowledged
  reason        text        'initial' | 'new_version' | 'scheduled'
  audience      text        JSON: { states: [], locations: [], roles: [] }; empty means everyone
  due_at        text
  status        text        'open' | 'closed'
  created_at    text
  closed_at     text

acknowledgment request + record           policies_acknowledgments
  id            text        ack_…
  org_id        text
  assignment_id text        asg_…
  staff_id      text        stf_…
  version_id    text        pov_… , denormalized so the proof survives a policy edit
  token_hash    text        sha-256 of the link token; the token itself lives only in KV
  sent_at       text
  acknowledged_at text      null until confirmed
  ack_ip        text        the originating IP at confirmation
  ack_user_agent text
  status        text        'pending' | 'acknowledged' | 'superseded'
  created_at    text

re-collection rule                        policies_rules
  id            text        rul_…
  org_id        text
  state         text        two-letter US state, or '*' for the org default
  category      text        matches policies_policies.category, or '*'
  interval_months integer   12 for NY and IL, 24 for CA
  enabled       integer     0|1
  created_at    text
  updated_at    text
```

The link token is **not** a row. `POST` of an assignment mints a random
128-bit token per recipient, writes `ackt:<token> → {ack_id, org_id}` into the
Workers KV namespace the worker binds as `ACK_TOKENS` with a TTL equal to the
round's due window plus a grace period, and stores only the SHA-256 of the
token in D1. A token is deleted from KV on confirmation, which makes it
single-use without a second D1 write.

## 2. The API

All authenticated routes sit behind `apps/api-edge` on the same `{ data, meta }`
envelope and the same error codes as the rest of the baseline, and all require
an active membership in `{org}`. Writes require the `admin` or `owner` role;
reads require any member.

### 2.1 The register

```
POST   /v1/organizations/{org}/policies                      → pol_
GET    /v1/organizations/{org}/policies                      ?status=&category=&cursor=
GET    /v1/organizations/{org}/policies/{pol}
PATCH  /v1/organizations/{org}/policies/{pol}                title, category, status
POST   /v1/organizations/{org}/policies/{pol}/versions       drafts; body_md + summary
PUT    /v1/organizations/{org}/policies/{pol}/versions/{pov}/document   streams the PDF into R2
POST   /v1/organizations/{org}/policies/{pol}/versions/{pov}/publish    seals it
GET    /v1/organizations/{org}/policies/{pol}/versions
GET    /v1/organizations/{org}/policies/{pol}/versions/{pov}
GET    /v1/organizations/{org}/policies/{pol}/versions/{pov}/document   streams it back
```

Publishing a version is three calls, not one, because the bytes do not belong
in a JSON body. `POST .../versions` allocates the next `version` integer under
a per-policy uniqueness index and returns a `pov_` in draft. `PUT
.../document` streams the request body straight into R2 under
`orgs/{org_id}/policies/{pol}/{pov}.pdf`, rejecting a content type outside the
whitelist and a body over 25 MB, and records `byte_size`, `content_type`,
`filename` and the `sha256` it computes as the bytes pass. `POST .../publish`
stamps `published_at` and moves `current_version_id`, and refuses with `409
version_empty` if the version has neither a document nor a `body_md`.

After `published_at` a version is frozen in both renditions: there is no
`PATCH`, a second `PUT .../document` is `409 version_immutable`, and the R2
object is never overwritten — a correction is a new version, which is the whole
point of the version history.

`GET .../document` streams the object back with its recorded content type and
an `ETag` of the stored `sha256`, for an administrator reading the register.
The staff-facing equivalent is on the public lane and is authorized by the link
token instead (§2.4).

### 2.2 The roster

```
POST   /v1/organizations/{org}/staff                         → stf_  (single or `{ staff: [...] }` bulk)
GET    /v1/organizations/{org}/staff                         ?state=&location=&role=&status=&cursor=
GET    /v1/organizations/{org}/staff/{stf}
PATCH  /v1/organizations/{org}/staff/{stf}
DELETE /v1/organizations/{org}/staff/{stf}                   deactivates; never hard-deletes, the proof outlives the employment
```

Bulk create is idempotent on `(org_id, lower(email))`: a repeat updates the
attributes rather than creating a duplicate, which is what a roster re-upload
means.

### 2.3 The round

```
POST   /v1/organizations/{org}/assignments                   { policyId, audience, dueAt } → asg_
GET    /v1/organizations/{org}/assignments                   ?policyId=&status=&cursor=
GET    /v1/organizations/{org}/assignments/{asg}             includes a { pending, acknowledged, superseded } tally
POST   /v1/organizations/{org}/assignments/{asg}/remind      re-sends to everyone still pending
GET    /v1/organizations/{org}/acknowledgments               ?policyId=&staffId=&status=&cursor=
```

Creating a round resolves the audience against the roster at that instant,
writes one `ack_` row per matched active member of staff, mints the tokens and
hands the batch to `notifications-worker`. Staff added later are picked up by
the next round, not retroactively — a round is a photograph, not a view.

### 2.4 The public lane

Two unauthenticated routes, the only ones this epic adds, rate-limited at the
edge by token and by IP:

```
GET    /v1/ack/{token}           → { policy: { title, category }, version: { version, body_md,
                                     summary, hasDocument, filename }, staff: { fullName },
                                     acknowledgedAt }
GET    /v1/ack/{token}/document  → streams that version's PDF out of R2
POST   /v1/ack/{token}           → records the acknowledgment; 200 once, 409 ack_already_recorded after
```

`GET .../document` resolves the token to its acknowledgment row, reads the
`pov_` that row names — never a policy's *current* version — and streams that
object. A member of staff therefore always reads the exact bytes the
acknowledgment will name, even if a newer version was published in between.

`POST` reads `CF-Connecting-IP` for `ack_ip`, stamps `acknowledged_at`, deletes
the KV token, emits the audit event and returns the receipt. An unknown or
expired token is `404 ack_link_invalid` — never a hint about which.

### 2.5 The calendar and the export

```
GET    /v1/organizations/{org}/rules
PUT    /v1/organizations/{org}/rules/{state}/{category}      upsert: interval_months, enabled
GET    /v1/organizations/{org}/policies/{pol}/export         text/csv, one row per staff member
GET    /v1/organizations/{org}/staff/{stf}/export            text/csv, one row per acknowledgment
```

A fresh organization is seeded on first read with the shipped defaults: `NY`
harassment 12 months, `NY` workplace_violence 12 months, `IL` harassment 12
months, `CA` harassment 24 months, `*`/`*` disabled. They are per-org rows from
the start, so an employer can override any of them without a code change.

## 3. The console

A new **Policies** section in `apps/web-console-next`, under the org-scoped
layout beside Projects:

- **Policies** — the register as a table (title, category, current version,
  outstanding count). A row opens the policy: its version history, the body of
  the current version, and a *Publish new version* editor.
- **Staff** — the roster, filterable by state, location and role, with bulk
  paste-in import and per-row status.
- **Assign** — a dialog on a policy: pick the version, pick the audience by
  state/location/role with a live "this matches N people" count, pick a due
  date, send.
- **Assignment detail** — the tally, the per-recipient list with its status and
  timestamps, and *Remind everyone pending*.
- **Compliance** — per policy and per employee, the acknowledgment trail with
  the version and the date, and the two CSV export buttons.
- **Calendar settings** — the rule grid by state × category, editable.

The staff-facing page is not in the console. `GET /v1/ack/{token}` is rendered
by a minimal server-rendered route on the same console Worker at `/ack/{token}`
so a member of staff sees a page, not JSON: the policy, the summary, a single
button, and after the post a receipt naming the version and the timestamp.

## 4. Events, secrets, and integrations

Audit events, emitted through the baseline's `events` context and therefore
visible in the existing audit surface and to signed outbound webhooks:

```
policy.created            policy.version.published      policy.retired
staff.created             staff.updated                 staff.deactivated
assignment.created        assignment.reminded           assignment.closed
acknowledgment.sent       acknowledgment.recorded       acknowledgment.superseded
rule.updated              recollection.round.opened
```

Email goes through `packages/notifications-client` to the existing
`notifications-worker` — two new templates, `policy-acknowledgment-request` and
`policy-acknowledgment-reminder`, each carrying the org name, the policy title,
the plain-language summary, the due date and the link. No new provider
connection, no new brokered secret: the baseline already holds the sending
credential.

Two new bindings on `policies-worker`, declared per environment in the worker's
component so stage and prod never share state: a KV namespace `ACK_TOKENS` for
the link tokens, and an R2 bucket `POLICY_DOCS` for the documents
(`ackstack-policy-docs-stage` / `-prod`). Both are provisioned the way the
baseline provisions D1 and KV — a terraform component under `infra/`, its id
published as a wiring secret and resolved into `wrangler.template.jsonc`
through a `@@wiring(...)@@` token. One cron trigger, nightly, on
`policies-worker`.

## 5. Out of scope

- **SMS delivery.** No Twilio credential; email only. Tracked as `AS-D`.
- **LLM plain-language summaries and Spanish translation.** The `summary` and
  `body_md` fields exist and are author-supplied; generating a summary,
  extracting `body_md` from an uploaded PDF and translating either is a later
  milestone, tracked as `AS-E`.
- **Payroll roster sync (Gusto, BambooHR).** The brief's own M4. The roster API
  is shaped so a sync can drive it, but no connector is built here.
- **Staff authentication.** Deliberately never; the link token is the whole
  identity story for a recipient, and `AS-B` records why.
- **Legal certification.** Ackstack records what happened; it does not assert
  that a given policy satisfies a given statute.
