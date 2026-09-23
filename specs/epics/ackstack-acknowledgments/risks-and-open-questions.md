# ackstack-acknowledgments — risks and open questions

Each entry is a letter, a title, and a state: **RISK** (open, with a
mitigation), **RESOLVED** (decided; say what and why), **ACCEPTED** (a cost we
carry knowingly), **SETTLED** (decided for now; revisit on a stated cadence).

## AS-A — a guessable or leaked acknowledgment link is a forged signature (RISK, mitigated)

The whole product is the claim "this person acknowledged this version on this
date", and the only thing standing behind that claim is a URL sent to an email
address. A guessed token would forge a signature; a forwarded one would let a
colleague acknowledge on someone's behalf, which the product cannot detect at
all. Mitigations: tokens are 128 bits from `crypto.getRandomValues`, so
guessing is not a threat model; only the SHA-256 lands in D1, so a database
read does not yield working links; confirmation is one conditional write on
the hash with an expiry (as built in D1, not KV — see IMPLEMENTATION-STATUS),
so a link is single-use and expires; the edge rate-limits the
public lane by token and by IP, so enumeration is not viable; and the recorded
IP and user agent give an auditor something to challenge. Forwarding remains
undetectable and is called out in `AS-B`.

## AS-B — staff never authenticate (RESOLVED)

The options were a full staff login (an identity per employee, password resets,
an onboarding cliff for a 40-person retail business), a per-recipient magic
link into the console, or a bare tokenized acknowledgment page. We chose the
bare page. The market this is for has no IT department and its staff have no
company email discipline; a login is the single most reliable way to make the
acknowledgment rate collapse, which is the metric the product lives on. The
cost is that the product proves a link was opened and confirmed from a given
IP, not that a specific human did it — the same evidentiary standard as the
e-signature tools it competes with, and weaker than a witnessed signature. We
state it plainly in the export rather than implying more.

## AS-C — policy documents live in R2 (RESOLVED)

The brief's first bullet is "upload a policy PDF (R2) with version history",
and when this epic was first drafted R2 was not enabled on the Cloudflare
account — the API answered `10042 Please enable R2 through the Cloudflare
Dashboard` — so the plan was Markdown-only bodies in D1. **The account operator
enabled R2 on 2026-09-23**, and the workspace's token was verified against the
bucket API (`GET /accounts/{id}/r2/buckets` answers `success: true`) before this
entry was changed. PDF upload is therefore in AS1, not deferred.

The decision that survives the unblock is to keep **both** renditions on a
version rather than replacing one with the other: the PDF is the artifact an
auditor wants, and the Markdown is what renders on the phone of a shift worker
standing in a stockroom, which is where an acknowledgment is actually
collected. A version is immutable in both, and the acknowledgment names the
version, so the pair can never drift apart. The residual cost is that an
employer who uploads only a PDF gets no phone-readable rendition until
someone writes one, which is the honest version of `AS-E`.

## AS-D — no SMS channel (ACCEPTED)

The brief offers "email/SMS magic link". We have no Twilio or equivalent
credential and the baseline brokers none, so AS2 is email-only. For the target
customer this is a real gap — retail and trades staff often read SMS and never
read email, and the acknowledgment rate is the metric — but a channel we cannot
send on is worth less than a channel we can. The assignment code path hands a
batch to `notifications-client` rather than composing mail inline, so adding a
second channel later is a delivery-side change and not a rework of the round.

## AS-E — the plain-language summary is author-supplied, not generated (SETTLED)

The pitch promises LLM summaries and Spanish translation. The version row
carries a `summary` field from the first migration and the acknowledgment page
renders it, so the surface is built; only the generation is missing. Doing it
properly needs a model binding, a cost budget per org and a human review step
before a machine-written summary of a legal policy is shown to staff as if it
were the policy — none of which belongs in a first release. Revisit once the
register has real content in it, and treat the review step as non-negotiable:
a mistranslated harassment policy is worse than an untranslated one.

## AS-F — a round is a photograph, and rosters churn (ACCEPTED)

Creating a round resolves the audience once and writes a fixed set of rows. A
member of staff hired the next day is not in that round and will not be chased
until the nightly cron opens the next one, which under a 12-month rule could be
a long time. The alternative — treating a round as a live query — makes the
tally unstable and the proof arguable, because "who was assigned" would change
retroactively. We accept the gap and close it in practice from AS3: the nightly
walk keys off *each member of staff's own* last acknowledgment, not the round's
date, so a new hire with no acknowledgment at all is due immediately and is
picked up on the first night.

## AS-G — we encode state law in a seed row (RISK, mitigated)

The rule table ships with New York annual (harassment, and workplace violence
under the 2025 Retail Worker Safety Act), Illinois annual and California
two-yearly. Statutes change, and an employer who trusts our defaults and is
wrong has a compliance failure with our name on it. Mitigations: the seeds are
per-org rows written on first read, not constants in the code, so an employer
or an advisor can change any interval without waiting for us; the console shows
the grid rather than hiding it; the export says what was collected and when,
not that it was sufficient; and the README is explicit that Ackstack records
evidence and does not certify compliance. The listing's own "looking for" line
asks for an HR-compliance advisor, which is the right long-term answer to this
entry.

## AS-H — the nightly cron must be idempotent under retry (RESOLVED)

Cloudflare may invoke a scheduled handler more than once, and a duplicate round
means a duplicate email to every member of staff — the most visible possible
failure for a product whose whole job is not to nag people wrongly. The
decision: the nightly walk is keyed on `(policy_id, staff_id, reason,
date(due_at))` through a unique index on the acknowledgment row, so a second
run in the same day inserts nothing and sends nothing. The handler also closes
each round it opens in the same transaction, and logs a count rather than
failing loudly on a conflict.

*As built (AS3):* the key moved to the round — `schedule_key =
scheduled:<pol_>:<UTC date>`, unique per org — plus a second guard that
excludes anyone with a pending request; rounds are not auto-closed. Proven by
a test that runs the nightly job twice on the same day. See
IMPLEMENTATION-STATUS departure 9.

## AS-I — email only reaches staff once a sending domain is verified (RISK, open)

The request email goes through the baseline's `notifications-worker`, which
sends with Cloudflare Email Service from `no-reply@mail.ackstack.app`. That
needs the `ackstack.app` domain on the account with DKIM/SPF verified, and
we do not hold it — a credential-shaped gap, not code. Until it exists the
worker falls back or records `notification.failed`, and every other part of
the flow works. Mitigation on stage only: it runs the baseline's
`DEBUG_DELIVERY=true` profile, under which the admin who sends a round gets
the links back, which is how the flow was verified end to end. Production
runs `DEBUG_DELIVERY=false` like the baseline's identity worker, so in prod
**both the staff request email and the admin's own magic-link sign-in depend
on this domain** — until it is verified, prod can be verified only on its
unauthenticated surface (health, `404 ack_link_invalid`, `401` on org
routes) plus the stage run of the identical code.

## AS-J — large rounds are sent over several invocations (ACCEPTED)

One invocation hands at most 40 emails to the mailer (subrequest and D1
per-invocation limits); the rest go out on the ten-minute sweep with fresh
links. A 300-person round therefore takes about an hour to fully send. Fine
for an SMB roster; a Queue-backed fan-out is the upgrade path if it is not.

