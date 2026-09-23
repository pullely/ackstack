terraform {
  required_version = ">= 1.15.0"

  # State lives on the platform (SB1): the runner exports TF_HTTP_* per job.
  backend "http" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.30"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.3"
    }
  }
}

# --- Providers ---

# Authenticates via the CLOUDFLARE_API_TOKEN env var (provider-native): the
# token is an orun-managed secret resolved into the job env at run time, so it
# never transits Terraform variables.
provider "cloudflare" {}

# --- Variables (standard Orun parameters) ---

variable "cloudflare_account_id" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare account ID (from CLOUDFLARE_ACCOUNT_ID env var)"
}

variable "orgName" {
  type    = string
  default = "sourceplane"
}

variable "owner" {
  type    = string
  default = "sourceplane"
}

variable "repo" {
  type    = string
  default = "ackstack"
}

variable "namespace" {
  type    = string
  default = "sourceplane"
}

variable "namespacePrefix" {
  type    = string
  default = ""
}

variable "lane" {
  type    = string
  default = "verify"
}

variable "environment" {
  type    = string
  default = "stage"
}

variable "component" {
  type    = string
  default = "cloudflare-r2"
}

variable "stackName" {
  type    = string
  default = "cloudflare-r2"
}

variable "terraformDir" {
  type    = string
  default = "terraform"
}

variable "terraformVersion" {
  type    = string
  default = "1.15.3"
}

# --- R2 bucket for policy documents (AS1) ---
#
# One bucket per environment. Objects are keyed
# orgs/{org_id}/policies/{pol}/{pov}.pdf and are never overwritten: a
# correction to a policy is a NEW version with a new key, which is what makes
# the acknowledgment trail provable. The bucket is private — every read goes
# through policies-worker, which authorizes it either by membership or by the
# acknowledgment link token.

locals {
  # Brand-namespaced with var.repo, for the same reason the KV namespace is:
  # this fork shares a Cloudflare account with the baseline and with the other
  # products built from it, and bucket names are unique per account.
  policy_docs_bucket_name = "${var.namespacePrefix}${var.repo}-policy-docs-${var.environment}"
}

resource "cloudflare_r2_bucket" "policy_docs" {
  account_id = var.cloudflare_account_id
  name       = local.policy_docs_bucket_name
}

# --- Wiring manifest (BF5, via orun secrets) ---
# An R2 binding resolves by bucket NAME, not by an opaque id, so the wiring
# document carries the name the worker's wrangler template substitutes.

output "wiring" {
  description = "Wiring document for downstream deploy-time binding resolution (pushed to orun secrets)"
  value = jsonencode({
    policy_docs_bucket_name = cloudflare_r2_bucket.policy_docs.name
  })
}

output "policy_docs_bucket_name" {
  description = "Cloudflare R2 bucket holding policy documents"
  value       = cloudflare_r2_bucket.policy_docs.name
}
