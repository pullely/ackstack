# ackstack-acknowledgments (AS) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | Task | PR |
|---|---|---|---|
| AS0 — the spec | ✅ | AS-1 | #9 |
| AS1 — the register and the roster | ✅ | AS-2 | #10 |
| AS2 — assign, send, acknowledge | | | |
| AS3 — the re-collection calendar | | | |

## AS1 — as built

- Migration `200_policies_core` (`policies_policies`, `policies_versions`,
  `policies_staff`), bounded context `policies` registered in `packages/db`.
- `apps/policies-worker` (policy CRUD, draft → `PUT` document → publish,
  roster CRUD with upsert-by-email), behind `apps/api-edge`'s
  `policies-facade.ts` on the `policies` rate-limit family.
- `infra/terraform/cloudflare-r2`: one private bucket per environment,
  `ackstack-policy-docs-<env>`, with a self-healing `adopt.tf` import.
- Four new org actions, `organization.{policy,staff}.{read,write}`: owners and
  admins get all four, builders and viewers the two reads.
- Console: **Policies** (register, version history, upload-and-publish) and
  **Staff** (roster, filters, CSV bulk import).

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
   names the bucket deterministically (`ackstack-policy-docs-<env>`), so the
   worker's `wrangler.template.jsonc` names it directly. That removes a
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
