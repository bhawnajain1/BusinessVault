# Changelog

All notable changes to BusinessVault are recorded here. This file is kept in
sync with `package.json` on every PR — see feedback_1_to_7.md §19 and the
per-PR-version-bump policy.

## 1.0.2 — 2026-08-27

### Added

- **Regression tests** pinning the dashboard/invoices-page/receivables-report coherence invariant. Extracted the dashboard KPI computation out of `Dashboard.tsx` into a pure `computeDashboardStats` function in `src/domain/dashboardStats.ts`, so it can be unit-tested without React. Added [`src/domain/dashboardStats.test.ts`](https://github.com/bhawnajain1/BusinessVault/blob/main/src/domain/dashboardStats.test.ts) with 13 tests that hand-craft the rename-edit trio (original + credit note + reissue) and pin `dashboard.invoices == invoices-page filter count` and `dashboard.outstandingReceivablesPaise == computeReceivables(...).totals.outstanding_paise`. Added [`tests/dashboard-coherence.spec.ts`](https://github.com/bhawnajain1/BusinessVault/blob/main/tests/dashboard-coherence.spec.ts) with 3 integration tests that run the real `InvoiceService.createInvoice` + `updateInvoice` code paths against fake-indexeddb — reproducing the exact debug-log scenario the user reported (4 creates → 2 renames → 1 more) and asserting all three surfaces agree on the count and totals. If a future change makes any surface diverge, one of these tests fails.
- **Debug diagnostics on the dashboard.** The `dashboard.stats computed` log line now includes `supersededInvoices`, `creditNotes`, `recycledInvoices`, `supersededPurchases`, and `debitNotes` counts alongside the live totals — so a future "count looks off" report can be diagnosed straight from the JSONL bundle without re-running the app. Added a `log.warn('dashboard', 'unusually large hidden-invoice gap', …)` guard that fires when the raw-vs-live gap exceeds 5× the live count (empirical threshold — see `Dashboard.tsx` for rationale).

## 1.0.1 — 2026-08-27

### Fixed

- **Dashboard: invoice count and outstanding totals were double-counting rename-edits.** When an invoice is edited with a new invoice number (§3), `InvoiceService.updateInvoice` performs a reverse + reissue: the original stays in `db.invoices` with `reversed_by_invoice_id` set, a credit note (`reverses_invoice_id`) is appended, and a fresh reissue is added — three rows per rename. The dashboard was calling `db.invoices.toArray()` and summing raw `balance_paise` across every row, so a rename made the count jump by +2 and the outstanding-receivables number drift upward. The Invoices page (`InvoicesPage.tsx`) already filtered out both `reversed_by_invoice_id` and `reverses_invoice_id` when `showVoided=false`, which is why the invoice list showed the correct 3 rows while the dashboard showed more. Fix: `Dashboard.tsx` now (1) filters to the same "live invoice" set for its count and Recent Invoices table, and (2) derives outstanding receivables/payables via `computeReceivables` / `computePayables` from `partyLedger.ts` — the same functions the Receivables/Payables report uses. Symmetric fix applied for purchases (`reversed_by_purchase_id` / `reverses_purchase_id`).
- Added structured `log.info('dashboard', 'stats computed', {...})` per the log-liberally policy so debug bundles capture the raw-vs-live counts and derived totals for future drift diagnosis.

## 1.0.0 — 2026-08-26

### Release: feedback_1_to_7.md series complete

The 28-section consolidated feedback landed across PRs [#40](https://github.com/bhawnajain1/BusinessVault/pull/40)–[#50](https://github.com/bhawnajain1/BusinessVault/pull/50) over ten shippable phases. This 1.0.0 release cuts the line: every feedback item that had a defined acceptance criterion is now implemented, tested against the §24 regression assertions, and gated by `npm run release:gate` (§26).

**§28 Final Report**

- Previous application version: `0.20.0`
- New application version: `1.0.0`
- Dexie schema version: `8` (last bumped in §2 Signature — no schema changes needed for this release)
- Backup format version: `1` (added in §20)

**Features implemented (Feedback #1–#7 + platform mandates §8–§26)**

| Section | Feature | Ships in |
|---|---|---|
| §1  | Invoice Round Off (auto / none / manual, banker's rounding, journal-integrated) | [`0.11.0`](https://github.com/bhawnajain1/BusinessVault/commit/b16edc7) |
| §2  | Authorised Signature (upload, per-invoice snapshot, historical preservation) | `0.14.0` |
| §3  | Editable Invoice Number (uniqueness guard, `audit_log` trail) | `0.13.0` |
| §4  | Invoice Number Reuse (recycled numbers released back into pool, gap-filling) | `0.13.0` |
| §5,§6,§7 | Sales Return audit + gap-fill (per-line economics, restore-summary rebuild) | `0.15.0` |
| §8  | Low-Stock / Reorder Alerts (threshold crossing, toast, sound, notification centre) | `0.16.0` |
| §9  | Recycle-Bin Accounting Bug (mirror-journal reversal, restore un-mirror) | `0.12.0` |
| §12 | GSTIN → State auto-detection (all four party forms, manual-override latch) | `0.17.0` |
| §13,§14,§15,§16 | Correlation IDs + Diagnostic Bundle (structured logs, redaction, downloadable JSON) | `0.18.0` |
| §17 | Reconciliation After High-Risk Operations (`reconcileAfter` wired into all edit/recycle/restore paths) | `0.19.0` |
| §19 | Application Version Bump (single source `package.json.version` → Vite `__APP_VERSION__` → Header + Diagnostic + Drive manifest) | Per-PR |
| §20 | Google Drive Backup / Restore (sales_returns, sales_return_items, attachments, audit_log now snapshotted) | `0.19.0` |
| §21,§22,§24 | Test suite + Cross-feature integration + Regression assertions | `0.20.0` |
| §26 | Release Gate (`scripts/release-gate.mjs` — typecheck + lint + unit + integration + build) | `0.20.0` |

**Tests (results from `npm run release:gate`)**

- Typecheck: PASS
- Lint: PASS
- Unit tests: PASS (all `src/**` .test.ts pass)
- Integration tests: PASS (all `tests/**` .spec.ts pass — including the Sharma Electronics disaster-recovery E2E)
- Regression assertions: PASS (21 unit cases in `src/testing/regressionAssertions.test.ts`)
- Migration tests: PASS (v6/v7/v8 migrations covered in the existing schema migration test suite)
- Drive backup/restore: PASS (`tests/e2e/google-drive-disaster-recovery.spec.ts` reconstructs bit-exactly from Drive alone)
- Production build: PASS (`vite build` succeeds)

**Also fixed in this release**

- **Stale post-GIS OAuth test.** `tests/e2e/interruption.spec.ts` scenario 5 was asserting pre-GIS behaviour (worker auto-reconnects on `OAUTH_EXPIRED`). Post-GIS the worker never auto-reconnects (no client secret, user gesture required) — the test now asserts the current contract: a `DriveNeedsReconnect` error surfaces via `onStateChange` as DISCONNECTED/ERROR so Settings can render the banner, and local Dexie writes keep working.

**Known limitations**

- `dist/assets/TrialBalancePage-*.js` weighs in at 954 kB minified (274 kB gzip). Warned but not blocked by Vite. Fixing needs `manualChunks` in `vite.config.ts`; deferred as it's a size-optimisation, not a correctness issue.
- `payment.edit` / `payment.recycle` / `payment.restore` op strings are accepted by `reconcileAfter` but not currently wired — those code paths don't exist yet in `PaymentService`. The op strings are reserved so future work can wire them without a signature change.

## 0.20.0 — 2026-08-26

### §22 §24 §26 — Reusable regression assertions, cross-feature integration, release gate

- **§24 Regression assertion library.** New
  `src/testing/regressionAssertions.ts` exposes eight named invariants —
  `assertAccountingBalanced`, `assertInvoiceDueNonNegative`,
  `assertPaymentAllocationsBounded`, `assertSalesReturnQtyBounded`,
  `assertInventoryIdentity`, `assertReceivablesConsistent`,
  `assertPayablesConsistent`, `assertRoundOffIdentity`,
  `assertNoDuplicateInvoiceNumbers` — plus `runFullRegressionSuite` which
  aggregates every assertion for a business into one pass/fail result. Every
  helper throws a typed `RegressionAssertionError` carrying the failing check
  slug and the numeric evidence, so a failure lands with actionable info,
  not just a boolean. Unit-tested in
  `src/testing/regressionAssertions.test.ts` (21 cases: each helper's happy
  path + at least one violation path, plus the aggregator).
- **§22 Cross-feature integration tests.** New
  `tests/cross-feature-integration.spec.ts` exercises real service call
  chains (no mocks) with `runFullRegressionSuite` after every step:
  - Round Off + Recycle + Restore — rounded invoice stays balanced through
    two full delete → restore cycles (catches mirror-journal drift on the
    round-off account specifically).
  - Round Off + Payment — paying a rounded invoice in full settles it to
    exactly zero balance with no fractional drift across A/R.
- **Fix (uncovered by §24).** `InvoiceService.createInvoice` was writing
  `journal_entries.total_debit_paise` / `total_credit_paise` as the invoice's
  `totalPaise`, ignoring the round-off Dr line that
  `buildInvoiceJournalLines` appended when the pre-round sum exceeded the
  rounded total. Per-line dr/cr sums balanced (17 paise on both sides), but
  the stored header was off by the same 17 paise. `accountingSelfCheck` and
  therefore §17 `reconcileAfter` would have tripped on any rounded invoice —
  no shipped tests exercised that combination. Fix: recompute the header
  totals from the actual `linesToPost` right before the write, so the header
  is guaranteed consistent with its lines.
- **§26 Release gate.** New `scripts/release-gate.mjs` runs the five
  mandatory pre-release checks in sequence — typecheck, lint, unit tests,
  integration tests, production build — and prints a per-check pass/fail
  table with per-check wall time. Non-zero exit iff any check failed.
  Wired into `npm run release:gate`.

## 0.19.0 — 2026-08-26

### Drive backup coverage + post-op reconciliation (feedback_1_to_7.md §17, §20)

- **§20 Drive backup — four missing tables now snapshotted.**
  `src/restore/tableSchema.ts` grows specs for `sales_returns`,
  `sales_return_items`, `attachments`, and `audit_log`. The Snapshot
  Now button and the (unwired) scheduler both pick these up
  automatically since `buildSnapshotInput` iterates `TABLE_SPECS`.
  Restore already loops the same specs — a Drive restore now
  reconstructs Sales Returns, attachment metadata, and the audit
  trail bit-exactly from CSV. Attachment BLOB bytes continue to ship
  out-of-band via `attachment_upload` sync jobs and are referenced
  from the row's `drive_file_id`; the CSV row itself is scrubbed of
  the raw `blob` field so it can never sneak into the CSV.
- **§20 manifest fields.** The snapshot manifest now emits
  `applicationVersion` (from Vite's `__APP_VERSION__` define,
  `'0.0.0'` fallback under Node test) and `backupFormatVersion`
  (new constant `BACKUP_FORMAT_VERSION = 1`) alongside the existing
  `schemaVersion`. Older snapshots without these fields still restore
  cleanly — the reader treats missing values as unknown.
- **§20 audit_log JSON round-trip.** `audit_log.before` and
  `audit_log.after` are pre-JSON.stringified at snapshot write time
  and coerced back through `tableSchema.coerceRow`'s `'json'` branch
  on read, so the columns round-trip through CSV without turning into
  `[object Object]`.
- **§17 reconciliation helper.** New `src/domain/reconciliation.ts`
  exposes `reconcileAfter(businessId, op, opts)` — runs
  `accountingSelfCheck` + a receivables consistency check, and on
  failure both writes a durable `reconciliation.failed` row to
  `audit_log` and emits a structured `log.warn`. Never throws —
  callers are on their happy path and a post-hoc invariant tripping
  must not roll back the domain op; the audit_log + debug bundle
  entries are how failures surface to support.
- **§17 wiring.** Reconciliation now runs after every high-risk op
  that has an implemented code path:
  - `InvoiceService.deleteInvoice` (invoice recycle)
  - `InvoiceService.restoreInvoice` (invoice restore)
  - `InvoiceService.updateInvoice` (invoice edit — reverse + reissue)
  - `SalesReturnService.createSalesReturn` (sales_return.create)
  - `SalesReturnService.cancelSalesReturn` (sales_return.cancel)
  - `PurchaseService.update` (purchase reverse + reissue)
  - `PaymentService.refundPayment` (payment.refund)
  - `rebuildFromDrive` was already wired (kept for parity).
  Payment edit / recycle / restore have no implementation to wire —
  the reconcileAfter helper accepts those op strings for when those
  paths land.
- **Tests.** `src/domain/reconciliation.test.ts` (4 cases: balanced
  journal → ok, unbalanced journal → failure + audit_log row, empty
  journal → ok, log breadcrumbs land). `src/sync/buildSnapshotInput.test.ts`
  gains 2 cases: manifest carries applicationVersion + schemaVersion +
  backupFormatVersion, and the four new CSVs are emitted with
  audit_log JSON preserved (never `[object Object]`).

## 0.18.0 — 2026-08-26

### Correlation IDs + Diagnostic Report bundle (feedback_1_to_7.md §13, §14, §15, §16)

- **§14 correlation IDs.** New `src/lib/operationId.ts` exposes
  `newOperationId()` (26-char Crockford-base32 ULID; time-sortable prefix)
  and `withOperation(event, opts, body)` — a thin wrapper that generates
  or reuses an `operationId`, logs `<event>.start` / `<event>.success` /
  `<event>.failure` bracketing the body, and rethrows on error. Any
  nested `log.info` inside the body that threads through the same
  `operationId` links to the outer operation in the diagnostic bundle.
  Callers pass `{ operationId }` down through service boundaries so a
  single Recycle / Restore / Backup / Restore-from-Drive traces to one
  contiguous log run.
- **§16 diagnostic bundle.** Settings → Support / Diagnostics now shows
  an **Export Diagnostic Report** button. Clicking it produces a
  timestamped `businessvault-diagnostic-<iso>.json` download containing:
  - App version + build mode (production / development)
  - Dexie schema version + business `schema_version`
  - Browser / platform / language user-agent context
  - Business metadata (id, name, state_code, drive_connected — never
    signature blob or OAuth tokens)
  - Trial-Balance reconciliation snapshot (debits/credits paise +
    balanced boolean) and receivables total
  - Last 100 `audit_log` rows for the current business, reverse-chrono
  - Last 24 h of `debug_logs`, plus grepped `drive.backup` and
    `drive.restore` sub-buckets so a Drive-flow report lands with just
    the relevant events at the top
- **§15 redaction.** The bundle re-uses the existing `log.ts`
  `SENSITIVE_KEY_RE` / `STACK_TOKEN_RE` / `LONG_TOKEN_RE` redaction —
  every entry it emits has already been scrubbed of `access_token`,
  `refresh_token`, `password`, `secret`, `api_key`, and any raw
  base64/hex tokens > 24 chars. A regression test asserts that a fake
  OAuth exchange log never surfaces in the exported JSON.
- **§13 log discipline.** All new code paths use `log.info` at entry /
  branch / exit with a stable `source` string so a support ticket can
  be triaged from the exported bundle alone, without asking the user to
  reproduce.
- **Tests.** `src/lib/operationId.test.ts` (5 cases: fresh ULID,
  monotonic time prefix, id generation, id reuse, start/success/failure
  logging, nested link) and `src/lib/diagnosticBundle.test.ts` (6 cases:
  empty state, business present, Drive-linked shape, audit reverse-chrono,
  backup/restore bucketing, sensitive-key redaction).

## 0.17.1 — 2026-08-26

### Fix: Data & Backup "DISCONNECTED" banner stuck after successful reconnect

- **Bug.** After completing Google Drive Reconnect from Settings → Data &
  Backup, the yellow "Google Drive backup disconnected" banner and the
  `DISCONNECTED` status pill remained on-screen even though Drive was
  actually connected and events were syncing (Last event sync updated,
  Pending = 0). Root cause: `BackupSettings.tsx` read
  `provider.connectionStatus()` **once at mount time**. The reconnect flow
  triggers a page reload, and on the first render immediately after the
  reload the sync-worker registry could still be empty for a brief moment.
  The `conn` state captured `DISCONNECTED` and never re-read — even after
  the worker registered its restored provider a second later.
- **Fix.** `BackupSettings.tsx` now polls `getActiveProvider().connectionStatus()`
  every 2 s (mirroring the `useBackupHealth` polling pattern already used
  for the sync-worker health value on the same screen). The status pill and
  banner now reflect current reality within one poll cycle of any change.
- **Testing.** New `src/ui/settings/BackupSettings.test.ts` pins down the
  `deriveDisplayStatus(conn, healthStatus, integrity)` precedence contract
  (extracted as a pure exported helper so future refactors can't reintroduce
  the stale-input regression). Includes an explicit "CONNECTED + HEALTHY
  must NOT display DISCONNECTED" assertion that replays the 2026-08-26 bug.
- **Debug logs.** Added structured `log.info` on every provider
  connection-state transition and every displayed-status transition, so
  future reports of this shape land with a clear trail in the exported
  debug bundle.

## 0.17.0 — 2026-08-26

### GSTIN → State auto-detection (feedback_1_to_7.md §12)

- **Auto-fill state from GSTIN in every party form.** Business onboarding
  (Step 2), Settings → Business Profile, Customers, and Suppliers now
  derive State/UT from the GSTIN's first two characters as the user types.
  Empty state field + valid 2-digit prefix → state auto-fills; keystroke
  changes to the prefix follow along.
- **Manual override wins.** Once the user picks a state from the dropdown,
  subsequent GSTIN edits do NOT overwrite that choice — instead an inline
  `⚠ GSTIN begins with 08 (Rajasthan), but selected State is Maharashtra
  (27). Please verify.` warning appears next to the field. Clearing either
  the GSTIN or the state re-enables auto-detect (that's how the user tells
  the form to resume auto-fill).
- **Detected badge.** A `✓ Detected from GSTIN: Rajasthan (08)` confirmation
  renders whenever the derived and selected state agree, so the shopkeeper
  can see the tax logic downstream will read the right code.
- **Centralised state-code map.** All four form surfaces plus the badge
  component now share the same helpers in `src/lib/gstinStateSync.ts` and
  `src/ui/components/GstinStateBadge.tsx`, and the duplicate map that
  lived in `ui/onboarding/state.ts` re-exports the canonical one from
  `src/lib/indianStates.ts` — one authority for the 40 codes.
- **Tests.** `src/lib/gstinStateSync.test.ts` covers 16 cases: prefix
  auto-fill, follow-along on prefix change, manual-override latch,
  clear-to-reset-latch, incomplete-prefix passthrough, mismatch detection,
  and legacy-record inference at load time.

## 0.16.0 — 2026-08-26

### Low-stock / reorder alerts (feedback_1_to_7.md §8)

- **Threshold-crossing detection.** Any stock movement — invoice line
  posted, sale-return restore, purchase received, adjustment — that pulls
  an item's cross-warehouse total from above its `reorder_level_micros` to
  at-or-below it fires a `bv:low-stock` window event. Follow-up decrements
  while still under the threshold do NOT re-fire; only the crossing itself
  does. Going back above the threshold fires a `cleared` event.
- **Zero touch on stock-writing services.** The detector rides on
  `item_stock` Dexie hooks in `src/db/database.ts` — every service that
  writes to `item_stock` (InventoryService, InvoiceService, PurchaseService,
  SalesReturnService, ReturnService, rebuildFromDrive) gets crossing
  detection for free, without any coupling to alert logic.
- **Notification centre.** New bell icon in the app header with an unread
  badge and a dropdown of recent alerts. Ephemeral (in-memory, per-tab) —
  the durable "what is currently low" view lives in Reports > Stock
  Valuation, which is the right place for that concern.
- **Toast + attention sound.** A crossing pops a bottom-right toast that
  auto-dismisses in 6 s and offers "View Item" / "Dismiss". A short two-
  tone WebAudio beep plays alongside — no asset bundled. Browser autoplay
  restrictions are handled gracefully: when the AudioContext is suspended
  the beep is skipped (logged, not thrown), and Settings > Test Sound
  gives the user a way to unlock alerts during a genuine click gesture.
- **Skip rules.** Services (`is_service=1`), items with
  `track_inventory=0`, and items with `reorder_level_micros=0` (unset
  threshold) never generate alerts.
- **Settings > Notifications.** Three device-local controls, backed by
  localStorage (no schema bump — this is UX state, not business data):
  Low Stock Alerts toggle, Notification Sound toggle, Test Sound button.
  Defaults ON per spec.
- **Tests.** `src/domain/lowStockAlerts.test.ts` covers 12 cases:
  crossing, non-re-fire while low, clear-when-recovered, out-of-stock
  branding, service skip, non-tracked skip, unset-threshold skip,
  cross-warehouse aggregation, missing-item safety, and snapshot loader.

## 0.15.0 — 2026-08-26

### Sales Return audit + gap-fill (feedback_1_to_7.md §5, §6, §7)

- **§5.3 — Sales Return picker shows original economics.** The per-line
  picker in `SalesReturnPicker.tsx` now surfaces the columns a shopkeeper
  needs to decide what they're refunding: **Unit** (looked up from the
  item's `unit_id`), **Orig. rate** (`line.unit_price_paise`), **Discount**
  (`line.discount_paise`), and **GST %** (`line.tax_rate_bps / 100`) — all
  read from the invoice line itself, never the current item-master, so
  edits to a product's price after the sale don't rewrite the return
  screen.
- **§7.4 — Snapshot restore rebuilds the return summary cache.**
  `rebuildFromDrive` now runs `rebuildInvoiceLineReturnSummary` after the
  inventory identity check and before the GST reconciliation pass. This
  closes a gap where a restore from an older snapshot (or event-only
  replay) would leave `invoice_line_return_summary` empty even though the
  authoritative `sales_return_items` rows were fully restored — the first
  render of the return picker post-restore now shows correct
  "Prev. returned" / "Available" values without waiting for the next
  create-return round-trip to backfill the cache.

All other §5, §6, §7 items (per-line qty capping, journal reversal,
inventory reversal, guard against editing an invoice with active returns,
customer credit issuance, hash-chain preservation across returns) were
already implemented in prior PRs — this release fills only the two audit
gaps.

## 0.14.0 — 2026-08-26

### Authorised Signature on invoices (feedback_1_to_7.md §2)

- **Settings → Business Profile** gains an *Authorised Signature* block:
  upload / preview / replace / remove, plus a *Show signature on new invoices*
  toggle. Uploads accept PNG, JPG, or WebP up to 2 MB and 2000×2000 px; the
  service (`src/domain/BusinessProfileService.ts`) validates MIME, size, and
  pixel dimensions and rejects with a `SignatureValidationError`.
- Signature images are stored as attachments with `ref_type='signature'`,
  `ref_id=<business_id>`. Every upload creates a **fresh** attachment row so
  historical invoices resolve to the signature that was current the day they
  were issued — replacing the signature never rewrites history.
- New invoices snapshot the current signature onto
  `invoice.signature_attachment_id` at creation time (only when the toggle is
  on). The invoice print surface (`InvoicePrint.tsx`) now renders the pinned
  attachment blob instead of the current business signature — so reprinting
  an old invoice still shows the exact image that appeared on the original.
- Schema is bumped to v8. Existing rows are backfilled (`signature_ref=null`,
  `show_signature_on_invoice=0`, `signature_attachment_id=null`) both at
  Dexie open time and at snapshot-restore time.
- New tests: `src/domain/BusinessProfileService.test.ts` covers validation,
  attachment write on first upload, fresh-row-on-replace (no mutation of the
  old row), signature-off toggling, and the historical-preservation
  invariant (INV-001 keeps V1, INV-002 pins V2, toggle-off yields null).

## 0.13.0 — 2026-08-26

### Editable invoice number + recycled-number reuse (feedback_1_to_7.md §3, §4)

- **§3** The Edit Invoice screen now allows changing the Invoice #. Uniqueness
  is validated within the business + prefix series; a rename writes an
  `invoice.number_changed` row to `audit_log` (with before/after) so the
  history is preserved. Renaming does NOT create a Sales Return — the edit
  path continues to reissue via the append-only reversal + fresh-invoice
  shape, just under the new number.
- **§4** A recycled invoice's number is released back into the pool.
  `allocateInvoiceNumber` now scans for the lowest recycled gap below
  `invoice_next_seq` and reuses it before incrementing the counter. The
  `createInvoice` uniqueness guard was widened to ignore rows with
  `deleted_at != null` in addition to already-superseded rows.
- New centralised helpers in `src/domain/invoiceNumbering.ts`:
  - `getNextAvailableInvoiceNumber(db, businessId)` — read-only preview of
    the next auto-allocation candidate.
  - `isInvoiceNumberAvailable(db, businessId, number, excludeInvoiceId?)` —
    true iff no LIVE invoice uses the number.
  - `validateInvoiceNumber(number, expectedPrefix?)` — format check
    (`PREFIX-<digits>`) with optional series match.
- Restore-conflict handling: `restoreInvoice` now throws a typed
  `InvoiceNumberConflictError` when the recycled invoice's number has been
  reused by a live invoice, so the UI can prompt the user to pick a fresh
  number before retrying restore.

## 0.12.0 — 2026-08-26

### Recycle Bin accounting (feedback_1_to_7.md §9)

- **Bug fix (highest priority in feedback).** A soft-deleted (recycled)
  invoice previously continued to contribute to Trial Balance, P&L, Balance
  Sheet, GST Summary, and party ledgers. `deleteInvoice` now posts a mirror
  journal entry against the invoice's original journal so the net effect on
  every journal-derived report immediately drops to zero.
- `restoreInvoice` posts an un-mirror (mirror-of-mirror) so the original
  effect returns exactly once — repeated delete → restore cycles stay
  balanced with no drift.
- Journals themselves are NEVER mutated or removed; the audit chain and
  event hash chain stay intact. Every mirror is a fresh `ref_type='reversal'`
  entry with `reverses_id` pointing back at what it neutralises.
- `gstSummary` and `computeReceivables` now filter recycled invoices — they
  read the `invoices` table directly (not the journals), so an explicit
  `deleted_at` filter was needed on those two surfaces.
- New optional field `deletion_reversal_journal_id` on Invoice records the
  mirror journal id while the invoice is in the Recycle Bin (null otherwise).
- Dexie schema bumped to **v7**. Upgrade backfills any pre-existing
  soft-deleted invoices by posting a mirror journal per row so on-disk data
  from earlier versions immediately becomes consistent. Same-shape backfill
  runs on snapshot restore via a new `v6 → v7` migration.

## 0.11.0 — 2026-08-26

### Round Off (feedback_1_to_7.md §1)

- Invoices, Purchases, and Sales Returns now persist an explicit
  `round_off_mode` (`auto` | `none` | `manual`) alongside the existing
  `round_off_paise` so the shopkeeper's rounding choice survives edits,
  restores, and reports.
- New `pre_round_total_paise` field on the same three tables records the
  taxable + GST + cess sum before rounding is applied. Together with
  `round_off_paise`, this makes the header self-describing.
- Invoice form: added a compact "Round off" control in the totals block —
  Auto (nearest ₹1, banker's rounding), None, or Manual (± rupees) — plus a
  "Subtotal" row shown when rounding is active so the pre-round total is
  visible at a glance.
- Journal entries continue to post the rounding difference to the existing
  `4900 Round Off` (other income) account, so the trial balance stays
  balanced to the paise regardless of the mode chosen.
- Dexie schema bumped to **v6**. Upgrade backfills existing rows with
  `round_off_mode = 'auto'` and `pre_round_total_paise = total_paise -
  round_off_paise`, preserving the invariant `pre_round + round_off =
  total`.
