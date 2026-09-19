# LET Junior — WhatsApp AI Sales Agent

Build per `SPEC.md`, milestone order M1→M6. Stack and constraints are in the spec; follow them.

## Override to SPEC §0/§12
The owner (Jordi, non-expert) asked for a **very simple, basic web page** to manage the service
(view leads/conversations, pause/resume the bot per lead, kill switch). Keep it minimal:
one static page + a few API routes, protected by a single shared password env var (`ADMIN_PASSWORD`).
Everything else in §12 stays out of scope.

## Working rules
- Never test against Jordi's production WhatsApp number (SPEC §11). Use dry-run mode.
- Secrets only in env vars; nothing committed.
- Verify Meta details (§13) against current docs before coding them.
