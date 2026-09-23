# cloudflare-r2

Provisions the Cloudflare R2 bucket holding policy documents (stage and prod)

Terraform-managed infrastructure for ackstack, per environment (`stage`, `prod`; `dev` is verify-only and provisions nothing).

## Depends on

- (none)

## Depended on by

- **policies-worker** — Cloudflare Worker for the policy acknowledgments runtime
