# MASTER_IMPLEMENTATION_PLAN.md

Phase-1 output for `feedback_1_to_7.md` (the 28-section master spec).
Repo: [`bhawnajain1/BusinessVault`](https://github.com/bhawnajain1/BusinessVault) · branch `feat/master-implementation-plan` (cut off `origin/main` @ `667f718`).
App version `0.6.1`. Dexie schema `v5`. No code changed by this document.

This plan maps every spec section to real files and calls out **already-implemented**, **gap**, and **collision** for each. Later phases (2–10) will land on their own branches.

---

## 0. Repo state at planning time

**Current Dexie schema (`src/db/schema.ts`, `src/db/database.ts`):**

| Version | Added | Notable for this spec |
| --- | --- | --- |
| v1 | Core tables — `businesses`, `invoices`, `invoice_lines`, `purchases`, `purchase_lines`, `payments` (with inline `allocations: PaymentAllocation[]`), `stock_movements`, `accounts`, `journal_entries`, `journal_lines`, `audit_log`, `sync_events`, `drive_file_map`, `attachments`, `auth_tokens`, `kv`. | `invoices.round_off_paise` and `purchases.round_off_paise` already exist as signed integer paise. `invoices.reverses_invoice_id` / `reversed_by_invoice_id` present. `payments.allocations` is a JSON array on the row, not a separate table. |
| v2 | `advances` | Customer/supplier advance model (`Advance` + `AdvanceApplication[]`); already cascades on invoice soft-delete. |
| v3 | `debug_logs` | Ring-buffered IndexedDB log table + `src/lib/log.ts` structured logger (`log.debug/info/warn/error(source, msg, ctx)`). Feeds spec §13–§16 essentially for free. |
| v4 | `[business_id+deleted_at]` index on `invoices` | Recycle Bin index. `invoices.deleted_at` / `deleted_reason` already exist; `payments.deleted_at` and `advances.deleted_at` cascade. |
| v5 | `sales_returns`, `sales_return_items`, `invoice_line_return_summary`, `legacy_reversal_audit` | Native Sales Returns, per-line summary cache, conservative legacy reversal migration audit. Ships with `src/domain/SalesReturnService.ts` + `src/domain/legacyReversalMigration.ts`. |

**Application/version sources of truth (§19 targets):**

- `package.json` → `version: "0.6.1"` (build-time inject as `__APP_VERSION__` via `vite.config.ts`; consumed by `src/ui/Header.tsx:11-13,47-50`).
- `src/db/schema.ts:1` → `export const SCHEMA_VERSION = 5;` — also written into Drive manifests at `src/drive/GoogleDriveStorageProvider.ts:434,442,457,462,842,890,910` and `src/restore/rebuildFromDrive.ts:429,553,572`.
- Business row carries `schema_version` (`src/db/types.ts:127`) for per-business snapshot pinning.
- No `backupFormatVersion` field distinct from `schemaVersion` today — snapshot files use `schemaVersion` only.
- No `CHANGELOG.md` at repo root yet.
- PWA manifest under `public/` (verify path in Phase 10; ensure name/short_name unchanged, no version string to update there unless we add one).

**Logging + audit surface:**

- `src/lib/log.ts` — structured logger with retention (5000 rows), redaction (`SENSITIVE_KEY_RE`, `LONG_TOKEN_RE`), on-disk mirror via `provider.appendLogLines`, dev-only console mirror, install hook `installGlobalErrorCapture()`.
- `src/lib/debugLogSink.ts:41` — `installDebugLogSink()`.
- `src/lib/downloadLogs.ts` — `exportLogsAsJsonl()` UI hook.
- `audit_log` Dexie table (`src/db/schema.ts:73`, row type `AuditLogEntry` at `src/db/types.ts:585`) — permanent business-history audit stream, separate from `debug_logs`. **Spec §15 (audit vs diagnostic separation) is already the design.**

**Test setup:**

- Vitest 2.1 + `@testing-library/react` + `fake-indexeddb` (`package.json`). Tests live next to source (`src/**/*.test.ts`) and integration under `tests/**/*.spec.ts`.
- Existing test files that must stay green: `InvoiceService.test.ts`, `PaymentService.test.ts`, `SalesReturnService.test.ts`, `AdvanceService.test.ts`, `PurchaseService.test.ts`, `ReturnService.test.ts`, `partyLedger.test.ts`, `legacyReversalMigration.test.ts`, `money.test.ts`, `ItemService.test.ts`, `CustomerService.test.ts`, `SupplierService.test.ts`, `CategoryService.test.ts`, `ExpenseService.test.ts`, `eventEmitter.test.ts`, plus integration `tests/accounting.spec.ts`, `tests/inventory.spec.ts`, `tests/csv-safety.spec.ts`, and `tests/e2e/*`.

**Chart of accounts:** `src/domain/coa.ts` seeds accounts. No `Round Off` ledger yet — §1 requires seeding one and posting the paise-level rounding to it (`src/accounting/postings.ts`).

**GST state map:** already centralized in [`src/lib/indianStates.ts`](src/lib/indianStates.ts) — `INDIAN_STATES`, `findStateByCode(code)`, and `stateFromGstin(gstin)` (line 53). Onboarding at `src/ui/onboarding/StepBusinessDetails.tsx:32` only *validates* GSTIN-vs-selected-state mismatch. §12 auto-detection is a wire-up on top, not a new mapping.

**Recycle Bin lifecycle gating (§9 target):** currently scattered — every consumer checks `.deleted_at` inline:
- `src/domain/InvoiceService.ts:669-816` — deleteInvoice/restoreInvoice with cascade to payments + advances.
- `src/domain/SalesReturnService.ts:148,276` — `original.deleted_at` and per-return active filter.
- `src/domain/invoiceLineReturnSummary.ts:28` — `sr.deleted_at != null` gate.
- `src/domain/partyLedger.ts` — `computeReceivables` / `computePayables` filter callers, but there is **no shared `isInvoiceFinanciallyActive()` helper**. Spec §9 requires centralizing.

---

## 1. Round Off — spec §1

**Already-implemented:**
- `Invoice.round_off_paise` (signed integer paise) and `Purchase.round_off_paise` fields on the row (`src/db/types.ts:268,331`). Also on `SalesReturn.round_off_paise:654`.
- Signed-paise money math via `src/lib/money.ts` (`money.test.ts` covers boundary conditions).

**Gap → work items:**
1. Add `round_off_mode: 'auto' | 'none' | 'manual'` to `Invoice` and `Purchase` row types. Also add `pre_round_total_paise: number` (or derive on-the-fly from `total_paise - round_off_paise`). Recommend explicit `pre_round_total_paise` so audits don't have to subtract.
2. Dexie migration → **v6**. Backfill existing rows: `round_off_mode='auto'`, `pre_round_total_paise = total_paise - round_off_paise`. Do **not** retro-round old invoices (spec §1 explicit).
3. Central calc in `src/domain/InvoiceService.ts` — compute pre-round → apply mode → stamp `round_off_paise` + `total_paise`. Purchase equivalent in `src/domain/PurchaseService.ts`.
4. Seed `Round Off` ledger in `src/domain/coa.ts`; wire into `src/accounting/postings.ts` (invoice posting, purchase posting, sales-return posting). Reversal path (`src/domain/AccountingService.ts:132 reverseJournal`) already handles by-line reversal correctly — verify.
5. UI: `src/ui/invoices/InvoiceForm.tsx` — add mode toggle + manual input field; render breakdown block above Total (matches spec §1 example layout).
6. `src/ui/invoices/InvoicePrint.tsx` — surface Round Off row between Pre-Round Total and Total.
7. Downstream verification checklist (`.50` case → round-half-to-even documented; document chosen behavior in a `docs/roundoff.md`):
   - Payment FULL uses `total_paise` (already true).
   - Receivable uses `total_paise` (already true — `computeReceivables` in `partyLedger.ts`).
   - Party ledger, dashboard, GST summary all currently read `total_paise` so no change beyond keeping the field name.

**Files touched:** `src/db/schema.ts`, `src/db/database.ts`, `src/db/types.ts`, `src/db/migrations/index.ts`, `src/domain/InvoiceService.ts`, `src/domain/PurchaseService.ts`, `src/domain/SalesReturnService.ts`, `src/domain/coa.ts`, `src/accounting/postings.ts`, `src/ui/invoices/InvoiceForm.tsx`, `src/ui/invoices/InvoicePrint.tsx`, plus new `docs/roundoff.md`.

**Collision surface:** every service that stamps totals; migration v6.

---

## 2. Authorised Signature — spec §2

**Already-implemented:** only the print-side placeholder at `src/ui/invoices/InvoicePrint.tsx:466-473` — the "For \<Business Name\> / Authorised Signatory" block with no image slot. No signature fields on `Business`. No settings tab.

**Gap → work items:**
1. Storage: add a new `signature_assets` table in Dexie v6 keyed by `id` with `business_id, format ('png'|'jpg'|'webp'), width, height, size_bytes, checksum, blob: Blob, drive_file_id?: string, created_at`. Reuse the existing `attachments` pattern — same shape as `Attachment` (`src/db/types.ts:569`).
2. `Business.current_signature_asset_id: string | null` and `Business.show_signature_on_invoices: number` (0/1).
3. Add `Invoice.signature_asset_id: string | null` — **stamped at issue time** so a later signature upload doesn't retro-change historical PDFs (spec §2 hard requirement).
4. Service: `src/domain/BusinessProfileService.ts` (new) — `uploadSignature(file)`, `removeSignature()`, `replaceSignature(file)`; validates PNG/JPG/JPEG/WebP, size cap (e.g. 512 KB), dimension cap, prefers transparent PNG (advisory only).
5. Wire the invoice-issue path in `InvoiceService.createInvoice` / `InvoiceService.updateInvoice` to snapshot `current_signature_asset_id` onto the invoice row iff `show_signature_on_invoices` is on.
6. UI: new `src/ui/settings/BusinessProfileSettings.tsx` with Upload/Preview/Replace/Remove + toggle. Extend `src/ui/invoices/InvoicePrint.tsx` to render the signature image (respecting aspect ratio, `max-h-16` typically) using the invoice's snapshotted `signature_asset_id`.
7. Drive round-trip: extend `src/drive/schemaDoc.ts` (schema doc) + `src/drive/GoogleDriveStorageProvider.ts` snapshot writer to include `signature_assets` as binary files under `snapshots/*/signatures/`. Restore path in `src/restore/rebuildFromDrive.ts` must reinstate the blobs.
8. Never log signature binary (spec §15 hard rule — existing `log.ts` redaction already excludes binary from `ctx`; verify).

**Files touched:** `src/db/schema.ts`, `src/db/types.ts`, `src/db/database.ts`, `src/db/migrations/index.ts`, new `src/domain/BusinessProfileService.ts`, `src/domain/InvoiceService.ts`, `src/ui/settings/BusinessProfileSettings.tsx` (new), `src/ui/invoices/InvoicePrint.tsx`, `src/drive/schemaDoc.ts`, `src/drive/GoogleDriveStorageProvider.ts`, `src/restore/rebuildFromDrive.ts`.

**Collision surface:** Dexie v6 migration shared with §1; Drive backup manifest coupling with §20.

---

## 3. Editable Invoice Number — spec §3

**Already-implemented:**
- `Invoice.invoice_number` (`src/db/types.ts:253`) with compound index `[business_id+invoice_number]` (`src/db/schema.ts:33`).
- Numbering service `src/domain/invoiceNumbering.ts` → `allocateInvoiceNumber(db, businessId)` (43 LOC). Uses `invoice_prefix` + `invoice_next_seq` on `Business`; walks past collisions in a tx. No scope-by-series/FY yet, no "isAvailable" API.
- `src/ui/invoices/InvoiceForm.tsx:322` accepts `invoiceNumberOverride`.

**Gap → work items:**
1. New helpers in `src/domain/invoiceNumbering.ts`:
   - `isInvoiceNumberAvailable(db, businessId, numberString, options: { financialYear?, series?, excludeInvoiceId? }): Promise<boolean>` — active-only check (skip rows with `deleted_at`).
   - `validateInvoiceNumber(db, businessId, numberString, options): Promise<{ ok: true } | { ok: false, reason }>`.
   - `getNextAvailableInvoiceNumber(db, businessId, options): Promise<string>` — see §4 for reuse rules.
2. Uniqueness scope = `business + series + financial_year`. Read the spec's stated scope literally; do **not** widen. `series` isn't a first-class field today — either derive from `invoice_prefix` or add `Invoice.series` in v6 (recommend deriving to avoid a new field).
3. `InvoiceService.updateInvoice` accepts a new-number arg; on change, writes an `audit_log` entry `{ action: 'invoice.number_changed', before: old, after: new }` (existing table). Does **not** create a Sales Return (spec §3 & §5 hard rule — enforced by not calling `SalesReturnService`).
4. Revisions/history: current revisions live in `reverses_invoice_id` linkage; keep old number on the superseded row.
5. UI: edit-mode input on `InvoiceForm.tsx`, inline availability check.

**Files touched:** `src/domain/invoiceNumbering.ts`, `src/domain/InvoiceService.ts`, `src/ui/invoices/InvoiceForm.tsx`.

**Collision surface:** couples with §4 number-reuse rules; both edit the same numbering service — land together.

---

## 4. Invoice Number Reuse After Recycle — spec §4

**Already-implemented:** `allocateInvoiceNumber` walks *past* collisions (i.e. never considers reusing a gap).

**Gap → work items:**
1. Extend `getNextAvailableInvoiceNumber(db, businessId, options)`:
   - Enumerate `invoices` in the current `(business, series, financial_year)` scope.
   - Find the **lowest** integer suffix not currently occupied by an **active** invoice (`deleted_at IS NULL`). Recycled numbers are gaps → reusable.
   - Bump `Business.invoice_next_seq` only when there is no gap.
2. Revisions/supersede events must **not** release their old number (spec §4 rule).
3. Restore conflict: on `InvoiceService.restoreInvoice`, if the original number is now taken by an active invoice → refuse with a typed error (`InvoiceNumberConflictError`) forcing the caller to supply an override. Do **not** silently overwrite either invoice. UI (`src/ui/invoices/DeletedInvoicesPage.tsx`) surfaces a modal: "Restore with number …".
4. Original number remains in `audit_log` even when a restore rewrites it.

**Files touched:** `src/domain/invoiceNumbering.ts`, `src/domain/InvoiceService.ts` (restore path lines `669-816`), `src/ui/invoices/DeletedInvoicesPage.tsx`.

**Collision surface:** with §3 (same file); with §9 (restore lifecycle).

---

## 5. Sales Return separate from Edit — spec §5

**Already-implemented (verified from schema + `SalesReturnService.ts` presence):**
- Native `sales_returns` + `sales_return_items` tables (v5).
- `SalesReturnService.createFromInvoice(...)` — line-level partial returns with historical pricing (per doc-comment on the schema types).
- `src/domain/invoiceLineReturnSummary.ts` — active-only aggregation.
- Edit-guard: `SalesReturnService.ts:148` refuses to build against a deleted invoice; the *edit-below-returned-qty* guard is asserted by the schema comment ("apply_to_balance vs customer_credit split") — Phase-2 will verify the guard call site in `InvoiceService.updateInvoice`.
- Sales Return numbering: `src/domain/salesReturnNumbering.ts` → `allocateSalesReturnNumber` mirroring invoice logic.
- Two UI entry points: "Create Sales Return" from InvoiceDetail (spec-required) and "New Sales Return → Select Invoice" (spec-required). Both must share the picker — verify in Phase 2.

**Gap → work items (small):**
1. **Audit** that `InvoiceService.updateInvoice` cannot ever call `SalesReturnService.createFromInvoice` (spec §5 hard rule). Add a static-analysis test or a code-review assertion in Phase 3.
2. **Verify** both entry points share the same picker component (`src/ui/returns/*`). If not, refactor to a single picker.
3. Add integration test: "editing an invoice never touches the sales_returns table" — write it against fake-indexeddb.

**Files touched:** likely audit-only; possibly a small refactor in `src/ui/returns/`.

---

## 6. Legacy Sales Return migration — spec §6

**Already-implemented:**
- `src/domain/legacyReversalMigration.ts` + `.test.ts` (v5).
- Four-way classifier: `SALES_RETURN` / `SALES_RETURN_UNRECONSTRUCTABLE` / `EDIT_REVERSAL` / `UNKNOWN` (`src/db/types.ts:634-638`).
- Idempotency via `legacy_reversal_audit.credit_note_invoice_id` primary key (`src/db/schema.ts:134`).
- Evidence trail (`evidence: {...}` at `types.ts:736-747`) preserves classification signals.
- UNRECONSTRUCTABLE case: no native SR created; original row preserved; audit-only.

**Gap → work items:** effectively none — this is the reference implementation for the spec's rules. Phase-2 will simply add a `legacyReversalAudit --report` script to `src/scripts/` for support.

---

## 7. Return quantity summary — spec §7

**Already-implemented:**
- `invoice_line_return_summary` table (v5).
- `src/domain/invoiceLineReturnSummary.ts` with `updated_at` + `returned_qty_micros`.
- Filters out cancelled + soft-deleted returns.

**Gap → work items:**
1. Expose an explicit `rebuildInvoiceLineReturnSummary(db, businessId): Promise<void>` if not already exported (verify — spec §7 wants it callable by name).
2. Ensure `src/restore/rebuildFromDrive.ts` calls it after restore (spec §7 "rebuild/reconcile from source records after restore").

**Files touched:** `src/domain/invoiceLineReturnSummary.ts`, `src/restore/rebuildFromDrive.ts`.

---

## 8. Low-stock / reorder alerts — spec §8

**Already-implemented:** `Item.reorder_level_micros` field (`src/db/types.ts:231`). `is_service` and `track_inventory` flags. No threshold-crossing logic anywhere.

**Gap → work items (medium new build):**
1. Central inventory eval — new `src/domain/lowStockService.ts` with:
   - `evaluateItemsAfterMovement(db, businessId, itemIds: string[]): Promise<LowStockCrossing[]>` — returns which items crossed `> reorder_level → ≤ reorder_level`, using the **previous** stock as measured before the current tx committed. Zero-crossing == `<= 0` becomes `OUT_OF_STOCK`.
   - Debounce/grouping: last-alerted state stashed in `kv` table so `55→50→49→40` alerts once.
2. Hook it into every stock-mutating path (spec §8 hard rule):
   - `InvoiceService.createInvoice` / `updateInvoice` / `deleteInvoice` / `restoreInvoice`.
   - `PurchaseService.*` (increases stock; may clear low-stock).
   - `SalesReturnService.*` (increases stock; may clear low-stock).
   - `ReturnService.*` (legacy purchase-return path — `src/domain/ReturnService.ts`).
   - Stock adjustment / opening stock / import — search for callers of `InventoryService`.
3. Notification bus — new `src/ui/notifications/` (context + toast + notification-center). One grouped notification when N items cross in a single op.
4. Sound: MP3/WAV in `public/sounds/low-stock.mp3`; play via `HTMLAudioElement`; handle autoplay policy (`AudioContext.state === 'suspended'`) — swallow errors, never break the transaction.
5. Settings: extend `src/ui/settings/` with a "Notifications" section — Low Stock Alerts ON/OFF, Notification Sound ON/OFF, Test Sound button. Persist under `kv` (`ui.notifications.*`).
6. Skip `is_service = 1` and `track_inventory = 0` items (spec §8 hard rule).

**Files touched:** new `src/domain/lowStockService.ts`, new `src/ui/notifications/*`, extensions in every service listed above, new `src/ui/settings/NotificationSettings.tsx`, new asset in `public/sounds/`.

**Collision surface:** with §9 — invoice recycle reverses stock; low-stock state must re-evaluate.

---

## 9. Recycle Bin accounting fix — spec §9 (HIGHEST PRIORITY)

**Already-implemented:** partial. `Invoice.deleted_at` cascades to `payments.deleted_at` and `advances.deleted_at`. `computeReceivables`/`computePayables` do read `.deleted_at` transitively (via the invoice/purchase they aggregate). Sales Return + summary code respects `deleted_at`.

**Gap → work items (biggest architectural item):**
1. **New helpers module** `src/domain/lifecycle.ts`:
   ```ts
   export function isInvoiceFinanciallyActive(inv: Invoice): boolean;
   export function isPurchaseFinanciallyActive(p: Purchase): boolean;
   export function isPaymentFinanciallyActive(pmt: Payment): boolean;
   export function isSalesReturnFinanciallyActive(sr: SalesReturn): boolean;
   ```
   These are the ONE definition each subsystem consults. No inline `deleted_at` checks.
2. **Refactor every consumer** to route through these:
   - `src/domain/partyLedger.ts:202 computeReceivables`, `340 computePayables`.
   - `src/accounting/reports.ts` — Trial Balance / P&L / Balance Sheet (currently stubbed; grep + wire).
   - `src/domain/gst.ts:127 gstSummary`.
   - `src/domain/InvoiceService.ts:892` (existing filter).
   - `src/domain/SalesReturnService.ts:276` (existing filter).
   - `src/domain/invoiceLineReturnSummary.ts:28` (existing filter).
   - Dashboard aggregations in `src/ui/pages/` and `src/ui/reports/`.
3. **Payment allocation suspend/restore.** Today allocations are inline JSON on the Payment row. When an invoice is recycled:
   - Payment record persists (correct).
   - Allocations against the recycled invoice must be marked *suspended* (not deleted) so payment amount stays intact, invoice receivable drops to 0, customer credit/advance for the residual is created.
   - **Recommend**: add `PaymentAllocation.status: 'active' | 'suspended'` (inline field bump, no new table). Migration v6 backfills all to `'active'`. Cascade in `InvoiceService.deleteInvoice`/`restoreInvoice` toggles per-allocation state.
   - Symmetric rules for Purchase + Payment Out.
4. **Journal reversal on recycle** — already the pattern (`AccountingService.reverseJournal`). Verify every recycle path calls it and that Trial Balance stays balanced post-recycle (assertion §17).
5. **Reconciliation after recycle/restore** — see §17. Add a `reconcileAfterOperation(operationId, kind)` call that:
   - `SUM(debits) === SUM(credits)` (assert)
   - Receivable/party-balance match
   - Stock movement math holds
   - Sales-return-summary matches raw items
   - Fails loudly to `log.error` (never silent).
6. **GST**: `gstSummary` must exclude recycled documents from CGST/SGST/IGST/Cess input+output totals but leave the historical journals intact.
7. **Cross-op invariant**: repeated Recycle → Restore cycles must be idempotent (no double-post, no lost effect). Add fuzz test in Phase 9.

**Files touched:** new `src/domain/lifecycle.ts`, new `src/domain/reconcile.ts`, edits to `src/domain/partyLedger.ts`, `src/accounting/reports.ts`, `src/accounting/postings.ts`, `src/domain/gst.ts`, `src/domain/InvoiceService.ts`, `src/domain/PurchaseService.ts`, `src/domain/PaymentService.ts`, `src/domain/SalesReturnService.ts`, `src/domain/ReturnService.ts`, `src/db/types.ts` (PaymentAllocation.status), Dexie v6 migration, dashboard components under `src/ui/pages/`.

**Collision surface:** touches almost every service — must land as a single reviewable PR with the reconciliation harness and >30 tests.

---

## 10. Invoice edit vs financial recalc — spec §10

**Already-implemented:** `InvoiceService.updateInvoice` recomputes totals + posts a reversal journal + stamps a new one (verified by pattern in `AccountingService.reverseJournal:132`).

**Gap → work items:**
1. Explicit refusal path when edited quantity < already-returned quantity — must throw a typed error, tested. If the guard is only in UI today, promote it to `InvoiceService`.
2. Never call `SalesReturnService.createFromInvoice` from `updateInvoice` (see §5).

**Files touched:** `src/domain/InvoiceService.ts`, tests.

---

## 11. Payment In / Out UI — spec §11

**Already-implemented (branch `feat/supplier-detail-page` had WIP for this; on `main` today):**
- `src/domain/PaymentService.ts:517 postInvoicePayments`.
- `src/domain/AdvanceService.ts` handles customer/supplier advances.
- Payments recycle bin, superseded revisions (per user memory of prior PRs).

**Gap → work items:** the plan itself is a merge/integration task since `feat/supplier-detail-page` has WIP that isn't on `main`. **Do not implement on this branch**; call it out for a follow-up branch.

**Files touched:** none in this session. Flag for future.

---

## 12. GSTIN → State auto-detect — spec §12

**Already-implemented:** `stateFromGstin(gstin)` at `src/lib/indianStates.ts:53`. Mismatch validator at `src/ui/onboarding/StepBusinessDetails.tsx:32`. `isInterstate(businessStateCode, partyStateCode)` at `src/domain/gst.ts:65`.

**Gap → work items (small):**
1. In `StepBusinessDetails.tsx`: on GSTIN blur (or valid-length reached), call `stateFromGstin` and set `form.state_code` + `form.state` iff user hasn't manually overridden (track `stateWasManuallySet: boolean` in local state).
2. Show `✓ Detected from GSTIN` chip next to the state field.
3. On manual override that conflicts with GSTIN prefix, show existing warning but do **not** auto-overwrite.
4. Apply the same auto-detect to Business Settings edit screen (`src/ui/settings/*` — verify a business-edit form exists or reuse the onboarding component).
5. Normalize GSTIN input: `.trim().toUpperCase()` before deriving.
6. Reject state detection from incomplete/invalid GSTIN (guard already present via `stateFromGstin` returning `undefined`).

**Files touched:** `src/ui/onboarding/StepBusinessDetails.tsx`, `src/ui/onboarding/state.ts`, `src/ui/settings/BusinessProfileSettings.tsx` (from §2).

---

## 13/14/15/16. Logging, correlation IDs, audit-vs-diagnostic, retention — spec §13–§16

**Already-implemented:**
- `src/lib/log.ts` structured logger, `push('debug'|'info'|'warn'|'error', source, msg, ctx)`.
- IndexedDB ring buffer (5000 rows, `MAX_ROWS` at `log.ts:23`).
- On-disk provider mirror (`appendLogLines`).
- Redaction: `SENSITIVE_KEY_RE`, `LONG_TOKEN_RE`, redacts Errors + nested objects (`log.ts:104-137`).
- Global error capture with amplification guard (`log.ts:159-192`).
- Export to jsonl (`log.ts:196 exportLogsAsJsonl`) + Settings UI hook (`src/lib/downloadLogs.ts`).
- Separate `audit_log` Dexie table (`src/db/schema.ts:73`) for permanent business audit — distinct from `debug_logs`.

**Gap → work items:**
1. **Correlation IDs (§14)** — add `operationId?: string` field to `DebugLogEntry` (v6 migration). New helper `withOperationId(id, fn)` using an `AsyncLocalStorage`-style store (or explicit passthrough since this is a browser PWA — recommend explicit `operationId` in `ctx` to avoid AsyncLocalStorage complexity).
2. **Log emission** at the events spec §13 lists (`invoice.recycled`, `payment.allocation_suspended`, `sales_return.created`, `inventory.reorder_threshold_crossed`, etc.). Each service call in Phases 2–8 emits these on entry/branch/exit.
3. **Diagnostic export bundle (§16)** — extend `exportLogsAsJsonl` into `exportDiagnosticBundle()` that emits a zip (or single JSON) containing:
   - `application_version`, `schema_version`, `browser`, `platform`.
   - Migration status.
   - Last Drive backup/restore result.
   - Last-N `debug_logs` (already sanitized).
4. Retention is already bounded to 5000 rows — spec §16 satisfied.

**Files touched:** `src/lib/log.ts` (add `operationId`), `src/lib/downloadLogs.ts` (bundle), `src/db/types.ts` (`DebugLogEntry.operationId`), Dexie v6 migration, all services from Phases 2–9 (emit named events).

---

## 17. Reconciliation after high-risk ops — spec §17

New module `src/domain/reconcile.ts` (see §9). Checks:

```
SUM(debits) === SUM(credits)                 — from journal_lines by business_id
receivables === SUM(active invoice balances) — from computeReceivables vs raw
payables === SUM(active bill balances)       — mirror
stock === opening + Σ(active stock_movements) — per item
gst_summary matches source transactions
Σ(active PaymentAllocation.amount) <= Payment.amount
Σ(active SalesReturnItem.qty) <= InvoiceLine.qty
```

Called at end of: `InvoiceService.updateInvoice`, `.deleteInvoice`, `.restoreInvoice`; `PaymentService.updatePayment`, `.deletePayment`, `.restorePayment`; `SalesReturnService.createFromInvoice`, `.cancel`; `PurchaseService.*` mirror; `rebuildFromDrive.finalize`. On failure → `log.error('reconcile', ...)` with `operationId`; UI toast in dev, silent-with-badge in prod.

**Files touched:** new `src/domain/reconcile.ts`, hooks in all high-risk service methods.

---

## 18. Dexie migrations — spec §18

**Single Dexie migration for this whole release: v5 → v6.** Adds:
- `Invoice.round_off_mode`, `Invoice.pre_round_total_paise` (§1).
- `Purchase.round_off_mode`, `Purchase.pre_round_total_paise` (§1).
- `SalesReturn.round_off_mode`, `SalesReturn.pre_round_total_paise` (§1 completeness).
- `Business.current_signature_asset_id`, `Business.show_signature_on_invoices` (§2).
- `Invoice.signature_asset_id` (§2 historical pinning).
- `signature_assets` table (§2).
- `PaymentAllocation.status: 'active' | 'suspended'` (§9).
- `DebugLogEntry.operationId?: string` (§14).

Backfill:
- `round_off_mode='auto'` on every existing row.
- `pre_round_total_paise = total_paise - round_off_paise` on every existing row (idempotent).
- `PaymentAllocation.status='active'` on every existing allocation.
- `show_signature_on_invoices=0` on every business.
- Everything else nullable/default.

Idempotent, data-preserving, logged with `log.info('migration', 'v5→v6', {...})`.

**Files touched:** `src/db/schema.ts` (add `STORES_V6`), `src/db/database.ts` (`this.version(6).stores(STORES_V6).upgrade(tx => …)`), `src/db/migrations/index.ts`.

---

## 19. Application version bump — spec §19

Current `0.6.1`. This release adds several features and a schema migration → **minor bump to `0.7.0`** (semver).

Update sources of truth (exact locations from §0):
- `package.json` → `"version": "0.7.0"`.
- `SCHEMA_VERSION` in `src/db/schema.ts` → `6`.
- `CHANGELOG.md` — create at repo root; document each of §1, §2, §3, §4, §8, §9, §12, plus schema bump.
- Header display already pulls from `__APP_VERSION__`; no code change.
- PWA `public/manifest.webmanifest` — verify no baked version; if present, update.
- Drive backup manifest fields — already write `SCHEMA_VERSION`; add `applicationVersion` and `backupFormatVersion=1` (new) to snapshot manifest in `src/drive/GoogleDriveStorageProvider.ts`.

---

## 20. Google Drive backup / restore — spec §20

**Already-implemented:** Rich provider at `src/drive/GoogleDriveStorageProvider.ts` (960+ LOC), staging-verify-move atomic snapshots, per-file checksums, schema doc rendered from `src/drive/schemaDoc.ts`, restore in `src/restore/rebuildFromDrive.ts`.

**Gap → work items:**
1. Add `signature_assets` binary payloads to the snapshot (§2).
2. Add `signature_asset_id` field to invoice snapshot (§2).
3. Add new v6 fields (`round_off_mode`, `pre_round_total_paise`, `PaymentAllocation.status`) to schemaDoc + snapshot writer.
4. Include `applicationVersion` and `backupFormatVersion` in every new snapshot manifest.
5. On restore, if `backup.schemaVersion > CURRENT_SCHEMA_VERSION` → refuse safely (already the pattern at `rebuildFromDrive.ts:209-261`; verify wording).
6. After restore: **rebuild derived caches** — call `rebuildInvoiceLineReturnSummary()`, `evaluateAllItemsForLowStock()`, `reconcile('drive_restore')`.

**Files touched:** `src/drive/schemaDoc.ts`, `src/drive/GoogleDriveStorageProvider.ts`, `src/restore/rebuildFromDrive.ts`.

---

## 21–24. Tests — spec §21–§24

Add regression tests for every fix. Group by phase:

- Phase 3 (§1 Round Off) → `src/domain/roundOff.test.ts` — down/up/exact/50-boundary/none/manual+/manual−/invalid.
- Phase 4 (§3/§4 Number) → extend `invoiceNumbering.test.ts` — edit/reject-dup/relationship-survives-rename/gap-reuse/restore-conflict.
- Phase 5 (§2 Signature) → `src/domain/BusinessProfileService.test.ts` — upload/replace/remove/historical-pin/Drive round-trip.
- Phase 6 (§8 Low Stock) → new `src/domain/lowStockService.test.ts` — cross/no-re-alert/replenish/re-cross/service/non-tracked/multi-item-group.
- Phase 2 (§9 Recycle Accounting) → new `tests/recycleBinAccounting.spec.ts` — unpaid/paid/partial/with-SR/purchase/PaymentOut/receivable/payable/party/TB/P&L/BS/GST/repeat.
- Phase 7 (§12 GSTIN) → `src/ui/onboarding/StepBusinessDetails.test.tsx` — 08/27/29/36/37/38/lowercase/whitespace/incomplete/invalid/no-GSTIN/manual/mismatch.

Cross-feature (§22): `tests/regression.crossFeature.spec.ts` — Round-Off+Payment, Round-Off+Recycle, Number+Payment, Number+Return, Reuse+Restore, LowStock+Recycle, GSTIN+Tax, Signature+Edit.

Disaster recovery (§23): `tests/e2e/disasterRecovery.spec.ts` — build fixture business → backup → wipe → restore → assert everything matches. Reuses existing `fake-indexeddb` harness.

Reusable assertions (§24): new `src/test/assertions.ts` with `assertBalancedJournals`, `assertDueGteZero`, `assertAllocationsLeAmount`, `assertReturnedLeSold`, `assertStockConsistent`, `assertReceivableMatches`, `assertPayableMatches`, `assertRoundOffFormula`, `assertNoDuplicateActiveInvoiceNumbers`.

---

## 25. Implementation order (recommended session plan)

| Phase | This session? | Deliverable |
| --- | --- | --- |
| 1 | ✅ this session | **`MASTER_IMPLEMENTATION_PLAN.md` (this file) on `feat/master-implementation-plan` → draft PR against `main`.** |
| 2 | next session | Recycle Bin accounting fix (§9) + lifecycle module + reconciliation + PaymentAllocation.status + tests. Biggest and highest-priority chunk. |
| 3 | next session | Round Off (§1). Own PR — shares the v6 migration with Phase 2, so land Phase 2's migration first. |
| 4 | next session | Editable Invoice # + reuse-after-recycle (§3, §4). Own PR. |
| 5 | next session | Signature (§2). Own PR — depends on v6 migration and Drive backup changes. |
| 6 | next session | Low Stock (§8). Own PR — depends on Phase 2 gates so recycle correctly re-evaluates. |
| 7 | next session | GSTIN → State auto-detect (§12). Own small PR. |
| 8 | next session | Drive backup manifest updates + restore reconcile (§20). Bundled with each preceding phase's schema changes or standalone. |
| 9 | next session | Full regression suite (§21–§23) + cross-feature + disaster recovery. |
| 10 | next session | Version bump to `0.7.0` + CHANGELOG + prod build (§19). |

---

## 26. Release gate — spec §26

Do not report completion unless:

```
npm run typecheck   PASS
npm run lint        PASS
npm run test        PASS
npm run test:e2e    PASS
npm run build       PASS

Trial Balance                  PASS  (reconcile.ts)
Receivables                    PASS
Payables                       PASS
Party Balance                  PASS
Inventory                      PASS
GST                            PASS
```

---

## 27. Known assumptions in this plan (verify before Phase 2)

1. **Round-half-to-even vs round-half-away-from-zero** for the `.50` case in §1 — plan proposes `Math.round(preRound / 100) * 100` which is banker-agnostic; document the observed JS `Math.round` behavior in `docs/roundoff.md`.
2. `PaymentAllocation.status` inline-field approach vs a new `payment_allocations` table — plan chooses inline to avoid a bigger refactor. Reconsider if `Payment.allocations[]` cardinality ever exceeds ~100 per payment (currently unbounded but small).
3. `series` for invoice number scope — plan derives from `invoice_prefix`. Confirm whether the user wants a first-class `series` field before Phase 4.
4. `signature_assets` as a new Dexie table vs storing in existing `attachments` — plan proposes a dedicated table so signatures don't leak into the attachments UI. Revisit if it feels over-engineered.
5. `AsyncLocalStorage` for `operationId` propagation isn't available in the browser — plan uses explicit `ctx.operationId` threading. Simpler.

---

## 28. Non-goals for this planning branch

- **No code changes.** This PR is the plan only.
- **No dependency additions.** Every proposed change uses existing packages.
- **No backend.** Same constraint as the spec.
- **No touching `feat/supplier-detail-page`** — that WIP is orthogonal to this spec and merges separately.
- **§11 Payment In/Out** is called out as already largely built on a different WIP branch; will not be re-implemented here.

---

*Generated for Phase 1 of `feedback_1_to_7.md` on 2026-08-26.*
