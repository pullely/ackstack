# ackstack-acknowledgments (AS) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | Task | PR |
|---|---|---|---|
| AS0 — the spec | ✅ | AS-1 | #9 |
| AS1 — the register and the roster | ✅ | AS-2 | #10 |
| AS2 — assign, send, acknowledge | ✅ | AS-3 | #11 |
| AS3 — the re-collection calendar | | | |

## AS1 — as built

- Migration `200_policies_core` (`policies_policies`, `policies_versions`,
  `policies_staff`), bounded context `policies` registered in `packages/db`.
- `apps/policies-worker` (policy CRUD, draft → `PUT` document → publish,
  roster CRUD with upsert-by-email), behind `apps/api-edge`'s
  `policies-facade.ts` on the `policies` rate-limit family.
- `infra/terraform/cloudflare-r2`: one private bucket per environment,
  `stg-ackstack-policy-docs-stage` / `prod-ackstack-policy-docs-prod`, with a
  self-healing `adopt.tf` import.
- Four new org actions, `organization.{policy,staff}.{read,write}`: owners and
  admins get all four, builders and viewers the two reads.
- Console: **Policies** (register, version history, upload-and-publish) and
  **Staff** (roster, filters, CSV bulk import).

## AS2 — as built

- Migration `210_policies_assignments` (`policies_assignments`,
  `policies_acknowledgments`), repository `packages/db/src/policies/rounds.ts`.
- `POST/GET /v1/organizations/{org}/assignments`, `GET …/assignments/{asg}`
  (tally + recipients), `POST …/assignments/{asg}/remind`,
  `GET /v1/organizations/{org}/acknowledgments`.
- The public lane `GET|POST /v1/ack/{token}` and `GET /v1/ack/{token}/document`
  through `apps/api-edge/src/ack-facade.ts` — no session, rate-limited per IP
  (family `ack`, 30/min), the caller's `CF-Connecting-IP` and user agent
  forwarded as `x-client-ip` / `x-client-user-agent`.
- Two templates in `notifications-worker`, `policy.acknowledgment_request` and
  `policy.acknowledgment_reminder`; `policies-worker` is an allowed internal
  caller.
- Console: **Assignments** (assign dialog by state/location/role, round detail
  with tally and *Remind everyone pending*) and the public `/ack/{token}` page.
- Events: `assignment.created`, `acknowledgment.sent`,
  `acknowledgment.recorded`, `assignment.reminded`.

## Departures from the design

### Baseline departures (the cirrus baseline itself, not this product's design)

1. **The cirrus D1 fix is applied (AS1, task AS-2).** The cirrus baseline ships
   Postgres-only SQL that D1 cannot run: `appendEventWithAudit` was a
   data-modifying CTE (`WITH inserted_event AS (INSERT …)`), and the
   membership repository had the same class of bug — so every audited write
   failed and **no organization could be created, meaning no customer could
   sign up**. The portfolio's shared patch (`cirrus-d1-fix.patch`, first landed
   in `chaseid` #10/#11) rewrites `packages/db/src/events/repository.ts` and
   `packages/db/src/membership/repository.ts` as sequential statements and adds
   a real-`node:sqlite` schema test (`tests/db/src/sqlite-schema.test.ts`).
   Because changing a shared package does not redeploy the workers that bundle
   it, the same PR touches `component.yaml` of admin, billing, config, events,
   identity, integrations, membership, projects, webhooks and policy workers.
   The `updated_at = now()` sites in config/webhooks repositories are not in
   the patch and are not touched by this product.
2. **`tests/db` integrations-migration ordering assertion rewritten.** It
   asserted that `180_integrations_foundation` is the second-to-last migration,
   i.e. that the baseline had never been extended. It now asserts its real
   intent: `190` sits immediately after the `180` it alters.

### Design departures

1. **The R2 bucket binds by name, not through a `@@wiring(...)@@` token.**
   design.md §4 and the AS1 plan said the bucket id would be published as a
   wiring secret. An R2 binding resolves by bucket *name*, and the terraform
   names the bucket deterministically, so the worker's
   `wrangler.template.jsonc` names it directly. The name is
   `<namespacePrefix>ackstack-policy-docs-<env>`, and the runner injects
   `namespacePrefix` per environment — the real buckets are
   `stg-ackstack-policy-docs-stage` and `prod-ackstack-policy-docs-prod`. AS1
   first shipped the unprefixed names and its policies-worker deploy failed
   with `R2 bucket … not found [code: 10085]`; fixed in the AS2 PR (#11). That removes a
   first-deploy ordering hazard (the worker lane resolving a
   `WIRING_CLOUDFLARE_R2` secret before the first apply has published it).
   The terraform still publishes the wiring document for anything that wants
   it. No account or resource id is committed either way.
2. **The R2 terraform runs under its own brokered token,
   `CLOUDFLARE_R2_TOKEN`** (scope template `r2-data`, minted per environment
   with `--param buckets=ackstack-policy-docs-<env>`), not the workers-deploy
   token — the same split the baseline makes for D1 with `CLOUDFLARE_D1_TOKEN`.
3. **`policies-worker` depends on `db-migrate`**, so `200_policies_core` is
   always applied before the code that reads it deploys.
4. **The link token lives in D1 (as a hash), not in a KV namespace
   `ACK_TOKENS`** (AS2). design.md §1 put `ackt:<token>` in KV with a TTL and
   deleted it on use. As built, `policies_acknowledgments.token_hash` carries
   a unique index and `expires_at`, and confirmation is ONE conditional
   `UPDATE … WHERE token_hash = ? AND status = 'pending' AND expires_at > ?
   RETURNING *`. KV is eventually consistent across locations, so a
   delete-on-use there is a weaker single-use guarantee than a conditional
   write in D1, and it removed a second store (and a wiring secret) from the
   path. The database still never holds a working link.
5. **A reminder or the send sweep mints a new link** and retires the previous
   one, because only the hash is stored. The newest email always works;
   an older one answers `404 ack_link_invalid`.
6. **Sending is budgeted: 40 emails per invocation.** Each send is a
   service-binding subrequest. A larger round leaves the rest `sent_at IS
   NULL` and a new `*/10 * * * *` cron on `policies-worker` sends them (with
   fresh links). `acknowledgment.sent` is one aggregate event per send batch,
   not one per recipient, for the same D1 per-invocation query budget.
7. **Under the baseline's `DEBUG_DELIVERY=true` profile the created links are
   also returned to the admin** (`debugLinks`), the same way identity-worker
   returns login codes inline under that flag. Stage and prod both run that
   profile today, because real email needs a verified sending domain (see
   risks AS-I).
8. **An audience matching nobody is `422`**, and assigning a policy with no
   published version is `409 policy_unpublished` — the design did not say.

