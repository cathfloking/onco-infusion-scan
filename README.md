# OncoScan — Oncology Infusion Scanner

Scan-based inventory tracking for oncology infusion medications. OncoScan records receiving, pulls and returns by lot, expiration and serial number, and keeps a complete activity record. Scan with a USB barcode scanner on a PC, or with the camera on a phone or tablet. GS1 DataMatrix is the source of the lot, expiration and serial data. The app can also read supplier packing slips and **reconcile a purchase order against its invoices and packing slips**.

> **Status:** Prototype (`prototype-0.7.0`). Not validated for regulated production use. No DSCSA or other regulatory compliance is claimed.

---

## Table of Contents
1. [Features](#features)
2. [Architecture](#architecture)
3. [Quick Start (Local)](#quick-start-local)
4. [Deployment (Cloudflare)](#deployment-cloudflare)
5. [Using the App](#using-the-app)
6. [Reconcile: Order, Invoice and Packing Slip](#reconcile-order-invoice-and-packing-slip)
7. [Packing Slip Import and Shipment Check-off](#packing-slip-import-and-shipment-check-off)
8. [Camera Scanning](#camera-scanning)
9. [Scan and Inventory Rules](#scan-and-inventory-rules)
10. [Administration](#administration)
11. [Database Migrations](#database-migrations)
12. [Security and Authentication](#security-and-authentication)
13. [Testing and Validation Status](#testing-and-validation-status)
14. [Known Limitations and Roadmap](#known-limitations-and-roadmap)
15. [Change Log](#change-log)
16. [Contributing Workflow](#contributing-workflow)

---

## Features

- **Receive, Pull, Return** workflow driven by a USB barcode scanner (PC) or the device camera (phone/tablet).
- **Camera scanning with a confirm step:** read a GS1 Data Matrix with the rear camera, review the parsed details, and save only after tapping Confirm.
- **Scan feedback:** beep and screen flash on every read; haptic tap on iOS 26.4 and earlier, and on Android.
- **One vial per scan** (no carton multiplier).
- **Serialized vials** tracked individually through RECEIVE, PULL and RETURN events.
- **Nonserialized stock** tracked by GTIN + original lot + original expiration.
- **Retry-safe:** request IDs prevent double counting when a network call is retried.
- **Packing slip import and shipment check-off:** read a supplier packing slip PDF in the browser, review it, save it as an expected shipment, then check vials off by scan or by manual lot-level receipt.
- **Reconcile tab (new):** three-way match of order history reports, invoices and packing slips, with a line audit, totals checks and a formatted Excel report. Runs entirely in the browser.
- **Home dashboard:** in-stock and out counts, items expiring within 90 days, drug library shortcut. The last-activity summary is on the More card.
- **Activity log** (More tab) with search; times shown in America/New_York (EST/EDT).
- **Excel export** (SheetJS): Inventory, Activity and Drug Library sheets; the Library button exports the Drug Library only. Exports use UTC.
- **Sortable tables:** click headers on desktop; "Sort by" control on mobile.
- **Themes:** Light, Dark or Auto (saved in the browser).
- **Admin tools:** drug library editing, archive/unarchive, package alias enable/disable, quantity adjustments, audit trail.

## Architecture

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Worker (`src/worker.js`) |
| Database | Cloudflare D1 (SQLite), binding `DB` |
| Frontend | Static assets in `public/` (plain JavaScript, no build step) |
| Camera scanning | `public/camera-scan.js`, `public/camera-scan.css`; decoder `zxing-wasm` loaded from jsDelivr |
| PDF reading | `public/vendor/pdfjs.js` and `pdfjs.worker.js` (self-hosted pdf.js) |
| Packing slips | `public/slip-parse.js` (pure parser), `public/slip-import.js` and `slip-import.css` (screens) |
| Reconcile | `public/recon-core.js` (pure parsers and matching), `public/recon-ui.js` (tab and Excel export), `public/recon.css` |
| Admin backend | `src/admin.js` |
| Shipments backend | `src/shipments.js` |
| Matching and queries | `src/matching.js`, `src/queries.js` |
| GS1 parsing | `src/parser.js` |
| Schema | `migrations/` |

`wrangler.jsonc` serves `./public` through the `ASSETS` binding with `run_worker_first: true`, so the Worker handles every request (including authentication) before static files.

Two separate D1 databases are used:
- **Production:** `onco-infusion-scan-db`
- **Preview:** `onco-infusion-scan-preview`, configured under `previews.d1_databases`

> Never bind preview or test work to the production database. A preview URL alone does not isolate data; the D1 binding does.

```
onco-infusion-scan/
├── migrations/            # D1 schema migrations (0001 … 0008)
├── public/                # Frontend
│   ├── index.html
│   ├── app.js             # Main app logic (scan form, tables, admin UI, navigation)
│   ├── camera-scan.js     # Camera scanning, confirm sheet, feedback
│   ├── camera-scan.css
│   ├── slip-parse.js      # Packing slip parser (pure functions, Node-testable)
│   ├── slip-import.js     # Slip import, review and shipment check-off screens
│   ├── slip-import.css
│   ├── recon-core.js      # Reconcile parsers + three-way matching (pure functions)
│   ├── recon-ui.js        # Reconcile tab, results tables, Excel export
│   ├── recon.css
│   ├── styles.css
│   ├── theme.js
│   └── vendor/            # pdfjs.js, pdfjs.worker.js (self-hosted)
├── src/
│   ├── worker.js          # Entry point, routing, security headers (CSP)
│   ├── admin.js           # Admin API
│   ├── shipments.js       # Expected shipments and manual lot receipts
│   ├── matching.js        # Product / package matching
│   ├── parser.js          # GS1 parsing, NDC helpers, AppError
│   └── queries.js         # Database queries
└── wrangler.jsonc         # Cloudflare configuration
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
- Camera access needs a secure context. `localhost` counts as secure; testing from a phone requires the HTTPS preview or deployed URL.

## Deployment (Cloudflare)

1. Create the production and preview D1 databases and set their IDs in `wrangler.jsonc`.
2. Set Worker secrets: `APP_USER`, `APP_PASSWORD`, `ADMIN_USER`, `ADMIN_PASSWORD`.
3. **Apply all migrations (through 0008) to the target database before deploying code.**
4. Push a branch and test its preview before merging to `main`.

**Preview workflow:** Cloudflare dashboard > Workers & Pages > `onco-infusion-scan` > Previews > select the branch > open the latest deployment. The stable Preview URL follows the branch; a Deployment URL pins one build. Before any write, confirm the preview uses the preview D1 binding and distinct test credentials. Apply migrations to preview separately from production.

## Using the App

Navigation is a bottom dock: **Home, Inventory, Scan (center), Reconcile, More**.

- **Scan:** choose Receive, Pull or Return, then scan with a USB scanner (into the scan box) or tap **Scan with camera**. The packing slip card (Import packing slip, Shipments) sits above the scan form. Scan box focus, diagnostics and unfinished state persist across navigation.
- **Inventory:** current stock by product/lot/serial, with filters, sorting and Excel export.
- **Reconcile:** compare order history, invoices and packing slips. See [Reconcile](#reconcile-order-invoice-and-packing-slip).
- **More:** three cards: **Activity** (full event history, searchable, collapsed by default), **Drug library** (collapsed by default; opens from the Home card), and **Administrator** tools. Links to `#activity` open More with the Activity card expanded.

Layout: above 940 px, tables use normal columns; at 940 px and below they become stacked cards. Reduced-motion preferences are respected.

## Reconcile: Order, Invoice and Packing Slip

The Reconcile tab checks that what was **ordered**, what was **invoiced** and what was **received** agree, in both quantity and dollars. It replaces the earlier desktop Python tool ("Triple Match Reconciler") and keeps its Excel report format.

**Privacy:** PDFs are read in the browser with the self-hosted pdf.js. Nothing is uploaded, sent to the Worker or stored in D1.

### How to use

1. Open **Reconcile**.
2. **Order history:** add one or more order history report PDFs (for example chemo and nonchemo).
3. **Invoices:** add the supplier invoice PDFs for the same order(s). One PO can have several invoices.
4. **Packing slips (optional):** add the supplier packing slip PDF. This adds the received-quantity check.
5. Press **Run 3-way match**. Review the results, then press **Export Excel** if you want the report.

Files can be chosen with the button or dragged onto a box. A note appears if a file looks like the wrong document type. Run needs at least one order history report and one invoice.

### What it checks

- Per drug (by 11-digit NDC): quantity ordered, invoiced and received; dollars ordered and invoiced; invoice unit price against order cost.
- Per PO: order history total against the invoice totals.
- Per document: each stated total against the sum of its own lines.
- Dollars are handled as integer cents, so there is no rounding drift.

### Status rules

| Status | Meaning |
|---|---|
| MATCH | Ordered, invoiced and (if a slip was added) received agree, and invoiced dollars equal ordered dollars. |
| REVIEW | No hard error, but a person should look. The packing slip lists the same drug under another order number, or the order history shows the supplier shipping fewer than ordered. |
| MISMATCH | A quantity, unit price or dollar amount differs; a drug was invoiced or received for an uploaded order but not ordered; or fewer vials are on the slip than ordered. |

Issue codes in the report: `NOT_ORDERED`, `NOT_INVOICED`, `QTY_INV_SHORT`, `QTY_INV_OVER`, `AMT_DIFF`, `PRICE_DIFF`, `SUPPLIER_SHORT_SHIP`, `OVER_RECEIVED`, `SHORT_ON_SLIP`, `SHORT_COVERED_OTHER`, `EXTRA_OTHER_ORDER`.

### Packing slips are not order specific

The supplier's slip can combine several orders. Each slip line is tied to an uploaded order by its **order number**:

- Lines for an uploaded order count as received for that order.
- Lines for other order numbers are **not** silently counted. When the same drug is on an uploaded order, they appear in the "On other orders" column, and the line is marked REVIEW if the quantity would otherwise cover a shortage or exceed the order.
- Lines for other orders and drugs not on the uploaded orders are listed separately and do not affect any status.
- If fewer vials are on the slip than ordered and nothing explains the gap, the line is MISMATCH with a note that the item may ship from another distribution center.

### Excel report

File name: `Reconciliation_PO_<PO numbers>.xlsx`. Sheets:

- **Reconciliation Results:** NDC, Drug Name, Match Status, Qty Ordered, Qty Invoiced, Qty Received, Amount Ordered, Amount Invoiced, then Qty On Other Orders (Slip), Issue Codes, Issue Detail, PO(s), Order #(s). Table style, green/red/amber status colors, accounting format and a grand-total row with SUM formulas.
- **Summary:** counts, totals, per-PO and per-document checks, notes from reading the files, and a status key.
- **Other Orders on Slip:** only when the slip has lines for orders that were not uploaded.

The styled workbook uses ExcelJS (`exceljs@4.4.0`), loaded from jsDelivr only when Export is pressed. If it cannot load, the app saves an unstyled workbook with SheetJS and says so. Generated times in the report are UTC.

### Supported documents

The parsers read the supplier layouts below by column position, not by fixed text:

- Order history report: Line, ABC#, Product Name, Order/Conf/Ship Qty, NDC/UPC, Acq. Cost, Ext. Cost, Total Cost, PO Number, Order Number.
- Invoice: Qty, UOM, Description, Item Number, NDC/UPC, Order, Unit Price, Extended Amount, Total Amount, P.O. Number, Invoice Number.
- Packing slip: the "Packing Slip" layout read by `slip-parse.js`.

Other suppliers' layouts may need parser changes. The screen warns when a file yields no lines.

## Packing Slip Import and Shipment Check-off

On the Scan tab, **Import packing slip** reads a supplier packing slip PDF in the browser (pdf.js) and opens a review screen. Nothing touches inventory until you act.

1. **Review:** fix any misread lot, expiration or quantity, set vials per unit for multi-vial packs, and remove lines you do not want. Save to create an **expected shipment** (planning data only, up to 99 lines).
2. **Check-off:** receipts scanned after the "count receipts since" time are matched to the slip lines. A line shows Pending, Partial, Complete or Over, and receipts that do not match the slip are listed separately.
3. **Manual receipt:** a line whose slip shows both a lot and an expiration can be received without scanning. This writes lot-level RECEIVE events labelled `packing-slip-manual`, and adds a library entry from the slip description if the drug is not in the library. Lines without a lot or expiration must be scanned.
4. Shipments can be closed, reopened or cancelled. Open lines can be edited.

Backend: `src/shipments.js` and tables from migration 0008 (`expected_shipments`, `expected_lines`).

## Camera Scanning

Camera scanning lets a phone or tablet read the Data Matrix barcode on a vial or package. It adds a convenience path alongside the USB scanner; it does not replace it.

### Requirements

- A current browser with camera access over HTTPS. Developed and tested on an iPhone 17 Pro Max (iOS 26.4.2) in **Safari**.
- Use Safari in the browser. Camera access is unreliable in iOS Home Screen (PWA) shortcuts, so installing the site as a Home Screen app is not recommended.
- Good, even lighting. iOS Safari offers no flashlight control to web pages.
- Allow camera access when prompted. If it was denied: Settings > Apps > Safari > Camera.

### How to use

1. Open the **Scan** tab and choose **Receive**, **Pull** or **Return**.
2. Tap **📷 Scan with camera** and hold the Data Matrix inside the teal square.
3. When a code is read, the camera pauses, the device beeps and flashes, and a **confirm sheet** appears.
4. Check the action, medication, library NDC11, GTIN, lot, expiration, serial and tracking mode. Warnings appear for expired manufacturer dates and archived library entries.
5. Tap **Confirm** to save exactly one vial, or **Rescan** to discard the read. Nothing is saved until you confirm.
6. After saving, the sheet shows the result. Tap **Scan next vial** to continue or **Done** to close.

If the product is not in the drug library, the button reads **Resolve product on Scan screen** and hands the scan to the existing add-product and package-alias panel.

### How it works

- The camera is opened with `getUserMedia`. The browser's built-in `BarcodeDetector` is not available in Safari, so frames are decoded in the page with [`zxing-wasm`](https://github.com/Sec-ant/zxing-wasm) (WebAssembly), restricted to **Data Matrix**.
- The decoder is loaded on first use from jsDelivr, pinned to version `3.1.2`. The `.wasm` file is fetched from `cdn.jsdelivr.net` to match the Content Security Policy.
- After a read, the page calls the existing `/api/inspect` endpoint to preview the match. Confirm then fills the scan box and submits the normal scan form, so request IDs, GS1 parsing, alias and archive rules, and retry safety are identical to a USB scan.
- Raw text is shown with the hidden group separator displayed as `<GS>`, so parsing problems are visible.
- While the camera is open, the scan box does not raise the on-screen keyboard.

### GS1 text normalization

The decoder can return GS1 data in human-readable form, for example `(01)00355566830319(21)…(17)…(10)…`. Those parentheses are added by the library and are not in the barcode, and the server parser rejects them. The camera module therefore:

1. Requests plain text from the decoder (`textMode: 'Plain'`).
2. Runs a fallback converter, `toRawGs1()`, that removes parentheses and inserts a GS (ASCII 29) after each variable-length field that is not last. Text that is already raw passes through unchanged.

The fixed-length application identifier list in the converter covers 00–04, 11–20, 31xx–36xx and 410–417. Extend it if new layouts are needed.

### Feedback

| Signal | When | Notes |
|---|---|---|
| Beep and screen flash | Every read; success and failure tones after saving | Sound can be silenced by the ring/silent switch. |
| Haptic tap | Read, save success, save failure | Works on Android. On iOS it uses a hidden `<input type="checkbox" switch>` trick that works through iOS 26.4. Reports indicate Apple broke it in iOS 26.5, so expect no haptics on later versions. |

## Scan and Inventory Rules

- Barcode parsing supports defined GS1 layouts only. Do not broaden ambiguous parsing casually.
- **Unknown product/package on Receive:** an admin flow can add a genuine library entry or a verified vial/package alias.
- **Disabled package alias (exact GTIN):** blocks fallback matching, recreation and new receipts. Recorded stock can still be pulled or returned.
- **Archived product:** blocks new Receive. Recorded stock can still be pulled or returned.
- Identical retried requests (same request ID) are never counted twice.
- Camera scans follow the same rules. Because lot-tracked vials from the same lot produce identical barcodes, the confirm step is the safeguard against accidental double-counting.
- Packing slip manual receipts are lot-level only, need a lot and an expiration on the slip, and are recorded as `packing-slip-manual`.
- **Reconcile never changes inventory.** It is a read-only audit aid.

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
| 0001–0004 | Initial schema, GTIN mappings, nonserialized packages, ondansetron package alias |
| 0005 | Library administration: edits, archive, alias controls, audit, version checks |
| 0006 | Append-only `lot_adjustments`; `lot_events_validate_v2` includes adjustments in availability checks |
| 0007 | `record_corrections` table and triggers; `products_identity_guard` replaces `products_identity_immutable` |
| 0008 | `expected_shipments` and `expected_lines` for packing slip import and check-off |

Camera scanning and Reconcile need no migration.

**0007 is required before deploying 0.7.0**, because queries reference `record_corrections`. **0008 is required** for packing slip import and shipments.

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
- Content Security Policy (set in `src/worker.js`): scripts from `'self'`, `'wasm-unsafe-eval'`, `https://cdn.sheetjs.com` and `https://cdn.jsdelivr.net`; connections to `'self'` and `https://cdn.jsdelivr.net`; `media-src 'self' blob:`; external CSS only (**no inline styles or style attributes**; setting styles from JavaScript is fine). SheetJS is pinned to `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`.
- **Third-party code:** the camera decoder (`zxing-wasm`) and the Reconcile Excel formatter (`exceljs@4.4.0`) are loaded from jsDelivr without an integrity check, and the CSP allows that whole host. This is acceptable for a prototype. Before clinical use, host both under `public/vendor/` and remove jsDelivr from the CSP. pdf.js is already self-hosted.
- Reconcile processes documents in the browser only; no document content reaches the Worker or the database.
- Never put real credentials in code, files, screenshots or issues.

## Testing and Validation Status

Validation to date is limited and mostly simulated:

- Phase 1: 68 simulated Node/SQLite tests (no live hardware or Cloudflare).
- 0.6.0: 37 backend checks against a SQLite D1 stand-in; 34 simulated Chromium frontend checks (SheetJS stubbed).
- PR #3 safety patch: function syntax checks and seven SQLite transaction-pattern checks. Not a full Worker/D1 or end-to-end browser regression.
- The `layout_improvements` branch was tested manually on a Cloudflare preview, and PR #3 was then merged to `main`.
- **Camera scanning (PR #4):** reviewed in code and tested manually on an iPhone 17 Pro Max (iOS 26.4.2, Safari) on the Cloudflare preview. Early testing exposed two problems that were fixed: the decoder's `.wasm` file was blocked by the CSP, and the decoder returned GS1 text with added parentheses (see [GS1 text normalization](#gs1-text-normalization)). The parentheses fix has not been independently re-verified with a full Receive/Pull/Return cycle on real vials.
- **Reconcile (PR #8):**
  - Parsers and matching were run in Node against one real order set (PO 14273: two order histories, four invoices, one packing slip). Results matched the earlier Python tool on all 50 lines for drug name, quantities and dollars.
  - Expected result for that set: 41 MATCH, 2 REVIEW (Rituxan 100 mg and Vegzelma 400 mg, each with extra vials on other orders), 7 MISMATCH (drugs short on or missing from the slip). Ordered and invoiced both total $672,885.78 ($177,521.23 chemo and $495,364.55 nonchemo), and every document's stated total equals its line sum.
  - The tab was then tested in the browser on the Cloudflare preview and worked as intended.
- **Not yet independently verified:** post-merge production deploy, production migrations 0007 and 0008 state, live USB scanner behavior, Excel export with the real SheetJS library, camera read rates across manufacturers, camera behavior on iOS 26.5 or later, and Reconcile against any supplier other than the one above.

A suggested camera pilot: scan 20–30 real vials from several manufacturers in clinic lighting, record read rate and time to read, and compare with the USB scanner on the same vials.

## Known Limitations and Roadmap

1. Sort order resets on browser reload; persist sort and filter preferences if wanted.
2. Not every admin table has a text filter.
3. Activity renders all matches (latest 100) with no pagination; plan for large histories.
4. `afterAdminSave` can show a refresh error and then overwrite it with a success toast.
5. Full inventory identity correction is not implemented. It must integrate scan matching, scan writes, collision checks and audit-safe reversals.
6. Void/correction of mistaken scans (Phase 2) is deferred; so is creating never-scanned lots.
7. Activity descriptions join current library descriptions rather than immutable snapshots.
8. Alias tooling covers package aliases only.
9. Add admin rate limiting.
10. Individual attribution (for example Cloudflare Access) is future work.
11. Legacy `public/admin.html`, `admin.css` and `admin.js` may remain; verify before removing. Keep `src/admin.js`.
12. No full DSCSA compliance claim.
13. Camera: self-host the decoder instead of using jsDelivr, and tighten the CSP.
14. Camera: reads Data Matrix only; linear barcodes (such as GS1-128) and QR codes are not read.
15. Camera: small, curved or glossy labels may read slowly; no torch/zoom on iOS Safari.
16. Camera: iOS haptics are expected to stop working on iOS 26.5 and later; beep and flash remain.
17. Camera: the GS1 normalizer uses a fixed-length AI table and should be extended or replaced with a full GS1 parser if more layouts appear.
18. Bump the worker version string and re-run the pilot after any decoder or CSP change. The version is still `prototype-0.7.0` after the Reconcile release.
19. Reconcile: parsers are calibrated on one supplier's order history, invoice and packing slip layouts. Add parser profiles for other suppliers.
20. Reconcile: the packing slip parser reads the PO as one word, so "14273-do not unbox" shows as "14273-do". This is display only; matching uses the order number.
21. Reconcile: slip quantities are compared as units (EA) against ordered units. Multi-vial pack conversion (`vials_per_unit`) is not applied.
22. Reconcile: self-host `exceljs` under `public/vendor/` (see Security).
23. Reconcile: add Node unit tests for `recon-core.js` using redacted sample PDFs.
24. Reconcile: optional later features: save a reconciliation record or audit entry, link a PO to an expected shipment, and PDF text from scanned images (OCR). Today only PDFs with selectable text are read.
25. Remove the unused `i-clock` icon from the SVG sprite in `public/index.html`.

## Change Log

- **PR #8 (Reconcile):** added the Reconcile tab (`recon-core.js`, `recon-ui.js`, `recon.css`); Reconcile replaces Activity in the bottom dock; Activity moved to a collapsible card on More; Home shows a Reconcile card, and last-activity text moved to the More card; `#activity` links open More with Activity expanded. No database or Worker change.
- **Packing slip import and shipments:** `slip-parse.js`, `slip-import.js/.css`, `src/shipments.js`, migration 0008, self-hosted pdf.js.
- **Camera scanning (PR #4):** see [Camera Scanning](#camera-scanning).

## Contributing Workflow

1. Branch from current `main`.
2. Preserve scan retry behavior, scan box focus handling, the camera confirm step and server-side admin gates.
3. Keep styling in external CSS files (the CSP forbids inline styles).
4. Test in a branch preview with the isolated preview D1 database. Test camera changes on a real phone in Safari over HTTPS.
5. Review table layouts at 940 px and below when adding columns (watch the admin Action column and sort indicators).
6. Merge via pull request only after preview testing.

---

*Prototype software for workflow evaluation. Validate thoroughly before any clinical or regulated use.*
