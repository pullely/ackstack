# Epic: ackstack-acknowledgments (AS)

**An employer can prove that a named member of staff read a named version of a
named policy on a named date — and the proof keeps arriving without anyone
remembering to ask for it. Today that proof lives in paper folders and inbox
threads, and it decays the moment a state's re-collection clock ticks over; the
design idea that fixes it is to make the *acknowledgment round* the resource
rather than the document: a policy version plus an audience plus a due date,
which a nightly rule engine can re-open on New York's annual clock, Illinois'
annual clock or California's two-year clock without a human in the loop.**

Ackstack is for US businesses with 15–300 staff and no full HR suite — retail,
clinics and trades, especially those with New York or Illinois employees. When
this epic ships they can keep a versioned policy register, hold a roster tagged
by location, role and work state, send a one-click acknowledgment link that
needs no staff login, and let the calendar re-collect on each state's own
schedule. Every acknowledgment carries the version, the timestamp and the
originating IP, and the whole trail exports per employee and per policy.

## Status

| Field | Value |
|-------|-------|
| Status | 🟡 Merged — final deploy pending (see IMPLEMENTATION-STATUS "Deploy state") |
| Cluster | **AS** (AS0–AS3) |
| Owner(s) | `apps/policies-worker` (the resource) · `packages/db` (the schema) · `packages/contracts` + `packages/sdk` (the wire) · `apps/api-edge` (the door) · `apps/web-console-next` (the surface) |
| Builds on | `cirrus baseline-v12` — extends identity/membership (who may administer), notifications (the email), events/audit (the trail), config (per-org defaults) and the api-edge public lane |
| Changes | Adds one bounded context, `policies`, in a new Worker and one D1 migration; every existing context is read, none is altered |
| Decisions locked | (1) A policy version is an immutable pair: the uploaded PDF in R2 and a Markdown rendition in D1, so the same version reads on a phone and prints as the document that was signed for. (2) Staff are recipients, not users: they never authenticate, they hold a single-use link token (as built: hashed in D1, not KV). (3) An acknowledgment is immutable and always names the exact `pov_` version it was given. (4) Re-collection is a nightly cron over declarative rules, not a per-policy timer. |
| Gate | AS1 is invisible (the register and the roster). AS2 is the first thing a member of staff ever sees. AS3 is the first thing that happens without anyone asking. |
| Shipped as | `pullely/ackstack` on cirrus `baseline-v12`: AS0 #9, AS1 #10 (tasks AS-1, AS-2), AS2 #11 (AS-3), AS3 #12 (AS-4), follow-up #13 (AS-5). Live at `https://ackstack-api-edge-{stage,prod}.nexo-7be.workers.dev` and `https://ackstack-web-console-next-{stage,prod}.nexo-7be.workers.dev`; nightly re-collection cron `15 6 * * *` and send sweep `*/10 * * * *` on `ackstack-policies-worker-{stage,prod}`. Not built (no credential): SMS, LLM summaries and Spanish translation, payroll roster sync — later milestones; real email needs the `ackstack.app` sending domain verified (risk AS-I). |

## Read order

1. `design.md` — the resource, the routes, the surfaces, what is out of scope
2. `implementation-plan.md` — the milestones and what "done" means for each
3. `risks-and-open-questions.md` — what could go wrong and what was decided
4. `IMPLEMENTATION-STATUS.md` — what actually shipped (kept distinct from intent)

## Milestones at a glance

| Milestone | What it lands | Done when |
|---|---|---|
| AS0 — the spec | this doc set | merged and pushed with `orun spec push` |
| AS1 — the register and the roster | `policies` schema, `policies-worker`, policy + immutable version + staff CRUD, the R2 document store, api-edge routes, console section | a policy PDF uploads, round-trips byte-for-byte through `/v1/organizations/{org}/policies/{pol}/versions/{pov}/document` on stage and prod, and a published version can never be edited |
| AS2 — assign, send, acknowledge | assignment rounds, audience selection by location/role/state, KV link tokens, the public ack lane, the acknowledgment email, audit events | an assignment emails every matched member of staff, and following the link and confirming writes an acknowledgment carrying version, timestamp and IP |
| AS3 — the re-collection calendar | state rules (NY annual + NY RWSA, IL annual, CA two-year), the nightly cron, supersession on a new version, the per-employee and per-policy export | the cron opens a due round without a human, publishing a new version supersedes outstanding requests, and both exports return CSV |
