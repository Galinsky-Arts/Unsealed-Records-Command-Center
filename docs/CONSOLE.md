# Command Center console (2026-11-17)

Every screen reads through the authenticated BFF; writes go through the same server with role and label checks.

| Screen | Data | Actions |
| --- | --- | --- |
| Overview | `/v1/summary` (label, family or all-label scope) | — |
| Releases | leaderboard, paged `/v1/catalog`, unmapped ISRCs | add/update catalog items (administrators) |
| Streaming | `/v1/rollups/daily` streams by day and provider (stored rollups when current) | — |
| Sales | sales/refunds/royalties by currency, distributor statement lines, reconciliations | — |
| Royalties | statement preview, stored statements, split rules, balances, payouts, CSV | edit split rules, save drafts (editors), finalize and record payouts (administrators) |
| Budgets | budgets with spend and utilization, expenses | create budgets and record expenses (editors) |
| Events | event/attendance counts, manual attendance reports | record attendance (editors), issue signed QR campaign links |
| TrackZero / SceneSignal | platform views | — |
| Alerts | persisted alert feed, delivery channel status | acknowledge (editors), evaluate now (administrators) |
| Imports | provider list with live-API status, import history | upload Spotify for Artists, Apple Music, YouTube, Stems, TooLost or engine CSV exports (editors) |
| Sources / Label reports | provenance, derived alerts, CSV exports, report modules | — |
| Admin | users, stored rollup status | add/edit/disable users, reset passwords, load/remove synthetic demo data |

Every panel shows its provenance: **Live engine data**, **Cached — not current** (an earlier response kept after a failed refresh), **Awaiting producer** (no data yet), **Synthetic demo data** or **Mixed live and synthetic** (scope includes the engine's synthetic demo label), or **Unavailable**.

## Users and roles

- The built-in administrator (`ADMIN_USERNAME`/`ADMIN_PASSWORD`) has all labels.
- Additional users are engine interactive accounts managed on the Admin screen; they sign in with their email. The Command Center verifies passwords through the engine (`/v1/accounts/verify`) and issues its own HttpOnly session with the account's role and labels; accounts are re-checked at least every minute, so disabled or re-scoped users lose access promptly.
- Roles: **Administrator** (all labels; manage), **Label manager** (edit own labels), **Team member** and **Artist** (read own labels). OIDC sessions remain read-only for their granted labels.
- Writes require `ENGINE_WRITE_API_KEY` (the engine's `ENGINE_CONSOLE_KEY`); without it the console is read-only and says so. The engine audit trail records the acting console user.

## QR campaigns

With `QR_SIGNING_SECRET` and `APP_ORIGIN`, editors issue HMAC-signed links (`/q/<token>`, valid up to 24 h). Opening a link records one anonymous, unverified scan per device per day as an `attendance` fact with source `qr-campaign`; nothing personal is stored.
