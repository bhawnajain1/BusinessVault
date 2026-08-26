# Changelog

All notable changes to BusinessVault are recorded here. This file is kept in
sync with `package.json` on every PR — see feedback_1_to_7.md §19 and the
per-PR-version-bump policy.

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
