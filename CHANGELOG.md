# Changelog

All notable changes to BusinessVault are recorded here. This file is kept in
sync with `package.json` on every PR — see feedback_1_to_7.md §19 and the
per-PR-version-bump policy.

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
