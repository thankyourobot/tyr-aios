# Multi-Tenant Skill Example: quint-bookkeeping

Reference implementation of the three-tier multi-tenant skill pattern. This is a real, production skill — study the structure and adaptation patterns.

## Core Tier (shared across all clients)

The versioned, updatable skill installed globally. Contains all operations, reference knowledge, shared scripts/adapters, and templates.

```
quint-bookkeeping/
├── SKILL.md                        # Entry point: activation, operations registry, reference registry
├── operations/
│   ├── onboard-firm.md             # First-time firm setup
│   ├── onboard-client.md           # First-time client setup
│   ├── process-period.md           # Main workhorse — work on a period's bookkeeping
│   ├── close-period.md             # Verify and seal a completed period
│   └── develop-adapter.md          # Build or modify a data adapter
├── reference/
│   ├── capability-registry.md      # All scripts and adapters — purpose, args, output contracts
│   ├── quality-guidelines.md       # Verification principles, hard stops, anti-fabrication
│   ├── bookkeeping-principles.md   # Core decision-making principles
│   ├── knowledge-capture.md        # How to update client knowledge files
│   ├── schema.sql                  # Database schema — query reference AND initialization
│   ├── adapter-patterns.md         # Adapter design conventions and code placement
│   ├── adversarial-review.md       # Domain-adapted review protocol
│   ├── subagent-patterns.md        # When and how to delegate to sub-agents
│   └── pdf-ingestion.md            # Principles for extracting financial data from PDFs
├── scripts/
│   ├── _shared/                    # Shared Python modules used across scripts
│   │   ├── config_loader.py        # Reads config.yaml, resolves paths
│   │   ├── journal_engine.py       # Journal entry creation logic
│   │   ├── period_resolver.py      # Fiscal period date calculations
│   │   ├── rule_matcher.py         # Category rule matching engine
│   │   └── trade_account_utils.py  # Trade account reconciliation helpers
│   ├── ingest_universal.py         # Ingest transactions from any adapter output
│   ├── verify_ingest_balances.py   # Balance verification after ingest
│   ├── apply_cat_rules.py          # Apply categorization rules to transactions
│   ├── bulk_cat_transactions.py    # Bulk categorize transactions
│   ├── apply_payment.py            # Apply a payment to trade accounts
│   ├── apply_transfer.py           # Apply a bank transfer
│   ├── create_trade_account.py     # Create a new trade account
│   ├── create_manual_journal.py    # Create a manual journal entry
│   ├── list_open_items.py          # List open/unprocessed items
│   └── test_cat_rule.py            # Test a categorization rule before applying
├── adapters/
│   ├── publish_to_qbo.py           # Publish journal entries to QuickBooks Online
│   ├── export_to_excel.py          # Export period data to Excel workbook
│   ├── sync_coa_from_qbo.py        # Sync chart of accounts from QBO
│   ├── sync_classes_from_qbo.py    # Sync class list from QBO
│   ├── sync_contacts_to_qbo.py     # Sync vendor/customer contacts to QBO
│   └── stripe_fc_*.py              # Stripe financial connection adapters
└── templates/
    ├── config-template.yaml        # Client config template (used during onboarding)
    ├── company-overview.md          # Template for client business overview
    ├── local-context-template.md    # Template for client context registry
    ├── period-close-workpaper.md    # Workpaper template for period closes
    ├── onboarding-workpaper.md      # Workpaper template for client onboarding
    └── fiscal-calendar-template.yaml
```

**Key patterns:**
- Scripts are atomic — one script, one operation, JSON to stdout
- `_shared/` module for common logic across scripts
- Adapters separate from scripts — adapters bridge external systems, scripts do internal work
- Templates for onboarding new clients (config, workpapers, content files)
- Schema reference serves double duty: query reference for the agent + initialization DDL

## Firm Tier (per-organization — optional)

Organization-specific conventions and shared context, deployed as a separate global config directory. Not all deployments need this — solo operators skip straight from core to local.

```
quint-firm/                          # e.g., ~/.claude/quint-firm/
├── config.yaml                      # Firm-level defaults (chart of accounts, fiscal calendar, conventions)
├── firm-context.md                  # Context registry — firm-wide reference files mapped to precondition triggers
├── content/                         # Firm-specific knowledge
│   └── coding-policies.md           # Firm-wide categorization policies
├── adapters/                        # Firm-specific adapters (shared across all firm clients)
└── reference/                       # Firm-specific reference docs
```

**Key patterns:**
- Firm config provides defaults that clients inherit (unless overridden locally)
- Firm context registry acts as fallback — local registry checked first, then firm
- Adapters here are shared across all clients in the firm

## Local Tier (per-client)

Client-specific configuration, content, and adapters. Lives in the client project directory.

```
_local-quint-bookkeeping/            # e.g., {project-root}/_local-quint-bookkeeping/
├── config.yaml                      # Client config — database path, firm reference, period settings
├── content/
│   ├── local-context.md             # Context registry — maps local files to precondition triggers
│   ├── company-overview.md          # Client business overview
│   ├── coding-context.md            # Client-specific categorization rules and context
│   ├── fiscal-calendar.yaml         # Client's fiscal calendar
│   ├── ingest.md                    # Client-specific ingest notes and source documentation
│   ├── trade-accounts.md            # Trade account context and conventions
│   └── manual-journals.md           # Recurring manual journal documentation
├── adapters/
│   ├── .env                         # Client-specific credentials (API keys, etc.)
│   └── ingest/                      # Client-specific ingest adapters
│       ├── bank_csv.py              # Bank-specific CSV parser
│       └── credit_card.py           # Card-specific parser
└── reference/                       # Client-specific reference data (optional)
    └── account_mappings.yaml        # Client-specific account mapping overrides
```

**Key patterns:**
- Config points to the database, firm tier, and local content paths
- Local adapters augment firm/core adapters of the same type
- Content files are the client's domain knowledge — what the agent learns gets written here
- `.env` for client-specific credentials (never committed)
- Context registry (`local-context.md`) maps files to precondition triggers — agent loads them on demand

## Resolution Order

```
Local → Firm → Core → error
```

First match wins at every level — adapters, context registry entries, config values. Client config overrides firm defaults. Firm defaults override core. This must be explicit and traceable — no implicit merging.
