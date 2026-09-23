# cloudflare-r2 — architecture

A `terraform` component rooted at `infra/terraform/cloudflare-r2/terraform`.

- **State** lives in the platform's HTTP state backend (run-token auth) —
  no local state, no cloud-vendor state buckets.
- **Credentials are brokered per run** from the workspace's Cloudflare
  connection; no long-lived provider secrets exist anywhere in CI.
- **Outputs are published as job-output secrets** on the environment
  rungs: `WIRING_CLOUDFLARE_R2` (bucket name for deploy-time binding). Downstream deploy lanes resolve them by name.
- **No adoption block**: unlike `cloudflare-kv`, this root is new with
  the product, so there is no pre-existing bucket for a half-torn-down
  attempt to collide with. If one is ever created out of band, import it
  before the next apply.
