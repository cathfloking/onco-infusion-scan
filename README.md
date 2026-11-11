# OncoScan — Oncology Infusion Scanner

Scan-based inventory tracking for oncology infusion medications. OncoScan records receiving, pulls and returns by lot, expiration and serial number, and keeps a complete activity record.

> **Status:** Prototype (`prototype-0.7.0`). Not validated for regulated production use. No DSCSA or other regulatory compliance is claimed.

---

## Table of Contents
1. [Features](#features)
2. [Architecture](#architecture)
3. [Quick Start (Local)](#quick-start-local)
4. [Deployment (Cloudflare)](#deployment-cloudflare)
5. [Using the App](#using-the-app)
6. [Scan and Inventory Rules](#scan-and-inventory-rules)
7. [Administration](#administration)
8. [Database Migrations](#database-migrations)
9. [Security and Authentication](#security-and-authentication)
10. [Testing and Validation Status](#testing-and-validation-status)
11. [Known Limitations and Roadmap](#known-limitations-and-roadmap)
12. [Contributing Workflow](#contributing-workflow)

---

## Features

- **Receive, Pull, Return** workflow driven by a USB barcode scanner (PC) or a mobile/tablet browser.
- **One vial per scan** (no carton multiplier).
- **Serialized vials** tracked individually through RECEIVE, PULL and RETURN events.
- **Nonserialized stock** tracked by GTIN + original lot + original expiration.
- **Retry-safe:** request IDs prevent double counting when a network call is retried.
- **Home dashboard:** in-stock and out counts, items expiring within 90 days, last activity, drug library shortcut.
- **Activity log** with search; times shown in America/New_York (EST/EDT).
- **Excel export** (SheetJS): Inventory, Activity and Drug Library sheets; the Library button exports the Drug Library only. Exports use UTC.
- **Sortable tables:** click headers on desktop; "Sort by" control on mobile.
- **Themes:** Light, Dark or Auto (saved in the browser).
- **Admin tools:** drug library editing, archive/unarchive, package alias enable/disable, quantity adjustments, audit trail.

## Architecture

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Worker (`src/worker.js`) |
| Database | Cloudflare D1 (SQLite), binding `DB` |
| Frontend | Static assets in `public/` (`index.html`, `app.js`, `styles.css`, `theme.js`) |
| Admin backend | `src/admin.js` |
| Queries | `src/queries.js` |
| Schema | `migrations/` |

`wrangler.jsonc` serves `./public` through the `ASSETS` binding with `run_worker_first: true`, so the Worker handles every request (including authentication) before static files.

Two separate D1 databases are used:
- **Production:** `onco-infusion-scan-db`
- **Preview:** `onco-infusion-scan-preview`, configured under `previews.d1_databases`

> Never bind preview or test work to the production database. A preview URL alone does not isolate data; the D1 binding does.

```
onco-infusion-scan/
├── migrations/        # D1 schema migrations (0001 … 0007)
├── public/            # Frontend (index.html, app.js, styles.css, theme.js)
├── src/
│   ├── worker.js      # Entry point and routing
│   ├── admin.js       # Admin API (live backend)
│   └── queries.js     # Database queries
└── wrangler.jsonc     # Cloudflare configuration
```

## Quick Start (Local)

> This guidance has not been fully validated locally. Migration trigger compatibility in local Wrangler is unverified.

1. Install a current Node.js LTS release.
2. Clone the repository and run `npm install`.
3. Create an ignored `.dev.vars` file with **distinct** technician and admin test credentials:
   ```
   APP_USER=<test-technician-user>
   APP_PASSWORD=<test-technician-password>
   ADMIN_USER=<test-admin-user>
   ADMIN_PASSWORD=<different-test-admin-password>
   ```
4. Apply migrations to the **local** database and start the dev server:
   ```sh
   npx wrangler d1 migrations apply onco-infusion-scan-db --local
   npx wrangler dev
   ```
5. Open `http://localhost:8787` (usual default).

Notes:
- Local D1 data lives under `.wrangler/`. Delete it to reset.
- Always pass `--local`. Avoid `--remote` while testing.
- Never commit `.dev.vars` or real credentials.

## Deployment (Cloudflare)

1. Create the production and preview D1 databases and set their IDs in `wrangler.jsonc`.
2. Set Worker secrets: `APP_USER`, `APP_PASSWORD`, `ADMIN_USER`, `ADMIN_PASSWORD`.
3. **Apply all migrations (including 0007) to the target database before deploying code.**
4. Push a branch and test its preview before merging to `main`.

**Preview workflow:** Cloudflare dashboard > Workers & Pages > `onco-infusion-scan` > Previews > select the branch > open the latest deployment. The stable Preview URL follows the branch; a Deployment URL pins one build. Before any write, confirm the preview uses the preview D1 binding and distinct test credentials. Apply migrations to preview separately from production.

## Using the App

Navigation is a bottom dock: **Home, Inventory, Scan (center), Activity, More**.

- **Scan:** choose Receive, Pull or Return, then scan. Scan box focus, diagnostics and unfinished state persist across navigation.
- **Inventory:** current stock by product/lot/serial, with filters, sorting and Excel export.
- **Activity:** full event history, searchable.
- **More:** drug library (collapsed by default; opens from the Home card), quantity tools and admin features.

Layout: above 940 px, tables use normal columns; at 940 px and below they become stacked cards. Reduced-motion preferences are respected.

## Scan and Inventory Rules

- Barcode parsing supports defined GS1 layouts only. Do not broaden ambiguous parsing casually.
- **Unknown product/package on Receive:** an admin flow can add a genuine library entry or a verified vial/package alias.
- **Disabled package alias (exact GTIN):** blocks fallback matching, recreation and new receipts. Recorded stock can still be pulled or returned.
- **Archived product:** blocks new Receive. Recorded stock can still be pulled or returned.
- Identical retried requests (same request ID) are never counted twice.

## Administration

Admin access requires separate credentials and an additional `X-Admin-Authorization` header (held in page memory).

**Drug library**
- Edit description, supplier ABC and NDC11 in a single atomic, version-checked request with one audit row.
- NDC11 can change only when no inventory, alias, GTIN mapping or adjustment references the entry (enforced by a database trigger).
- Permanent internal key, timestamps and version are read-only.
- Archive/unarchive instead of deleting.
- Enable/disable package aliases with a recorded reason.
- Library import is admin-only on the server, additive, and never overwrites admin-edited entries.

**Quantity adjustments**
- Add or remove In-stock or Out quantity for **existing nonserialized lot groups only**.
- Reason required (8–500 characters); at most 1000 per change; negative balances blocked by database guards.
- Adjustments are append-only (`lot_adjustments`), appear in Activity and the audit log, and are included in exports.
- Each save is one atomic batch with stale-data protection. If counts changed since the page loaded, the save is rejected.
- Serialized vials cannot be administratively changed; use Pull/Return.

**Inventory identity editing is intentionally disabled.** Edits to lot, expiration, serial and scanned NDC are rejected (`IDENTITY_LOCKED`). Scanning still matches raw ledger identities, so a display-only correction could show values that scans cannot resolve and could allow collisions. Records with earlier identity overlays are blocked from quantity edits (`CORRECTION_REVIEW`).

## Database Migrations

| Migration | Purpose |
|---|---|
| 0005 | Library administration: edits, archive, alias controls, audit, version checks |
| 0006 | Append-only `lot_adjustments`; `lot_events_validate_v2` includes adjustments in availability checks |
| 0007 | `record_corrections` table and triggers; `products_identity_guard` replaces `products_identity_immutable` |

**0007 is required before deploying 0.7.0**, because queries reference `record_corrections`.

Verify in the correct D1 console:

```sql
SELECT name
FROM sqlite_master
WHERE type = 'trigger'
  AND (name LIKE 'record_corrections%' OR name LIKE 'products_identity%');
```

Expected: `record_corrections_validate`, `record_corrections_no_update`, `record_corrections_no_delete`, `products_identity_guard`, and **not** `products_identity_immutable`.

Check for legacy identity overlays:

```sql
SELECT COUNT(*) AS correction_count FROM record_corrections;
```

A nonzero count needs review. Do not delete append-only correction or audit history casually.

## Security and Authentication

- Technician access: HTTP Basic auth using Worker secrets `APP_USER` and `APP_PASSWORD`.
- Admin access: separate `ADMIN_USER` / `ADMIN_PASSWORD`, plus the `X-Admin-Authorization` header.
- The app fails closed if admin configuration is missing or if technician and admin passwords match.
- Audit entries use the shared actor `shared-admin-credential`. This is **not** individual attribution.
- Basic auth has no reliable technician logout.
- No admin rate limiting yet.
- The Content Security Policy is why CSS is external and SheetJS is pinned to `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`.
- Never put real credentials in code, files, screenshots or issues.

## Testing and Validation Status

Validation to date is limited and mostly simulated:

- Phase 1: 68 simulated Node/SQLite tests (no live hardware or Cloudflare).
- 0.6.0: 37 backend checks against a SQLite D1 stand-in; 34 simulated Chromium frontend checks (SheetJS stubbed).
- PR #3 safety patch: function syntax checks and seven SQLite transaction-pattern checks. Not a full Worker/D1 or end-to-end browser regression.
- The `layout_improvements` branch was tested manually on a Cloudflare preview, and PR #3 was then merged to `main`.
- **Not yet independently verified:** post-merge production deploy, production migration 0007 state, live USB scanner behavior, and Excel export with the real SheetJS library.

## Known Limitations and Roadmap

1. Fix stale help text in `public/index.html` (Activity "Latest 100 entries"; "Every column can be edited"; inventory edit wording for serialized rows).
2. Sort order resets on browser reload; persist sort and filter preferences if wanted.
3. Not every admin table has a text filter.
4. Activity renders all matches with no pagination; plan for large histories.
5. `afterAdminSave` can show a refresh error and then overwrite it with a success toast.
6. Full inventory identity correction is not implemented. It must integrate scan matching, scan writes, collision checks and audit-safe reversals.
7. Void/correction of mistaken scans (Phase 2) is deferred; so is creating never-scanned lots.
8. Activity descriptions join current library descriptions rather than immutable snapshots.
9. Alias tooling covers package aliases only.
10. Add admin rate limiting.
11. Individual attribution (for example Cloudflare Access) is future work.
12. Legacy `public/admin.html`, `admin.css` and `admin.js` may remain; verify before removing. Keep `src/admin.js`.
13. No full DSCSA compliance claim.

## Contributing Workflow

1. Branch from current `main`.
2. Preserve scan retry behavior, scan box focus handling and server-side admin gates.
3. Test in a branch preview with the isolated preview D1 database.
4. Review table layouts at 940 px and below when adding columns (watch the admin Action column and sort indicators).
5. Merge via pull request only after preview testing.

---

*Prototype software for workflow evaluation. Validate thoroughly before any clinical or regulated use.*
