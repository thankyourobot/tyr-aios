# tyr-aios (Archived)

This repository has been superseded by the Commonclaw rebuild.

## New Repositories

- **Platform:** [thankyourobot/commonclaw](https://github.com/thankyourobot/commonclaw) — the Commonclaw platform (forked from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw))
- **Tenant config:** [thankyourobot/tyr-claw](https://github.com/thankyourobot/tyr-claw) — TYR-specific directors, skills, and overrides
- **Infrastructure:** [thankyourobot/claw-infra](https://github.com/thankyourobot/claw-infra) — Terraform, cloud-init, backup/DR

## Why

TYR pivoted from a monolithic fork to a two-repo model: a clean platform repo (`commonclaw`) plus per-tenant configuration repos (`{tenant}-claw`). This makes the platform reusable across clients while keeping each deployment's customizations isolated.

This repo is archived for historical reference. No further development will happen here.
