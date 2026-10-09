# Monthly GST Working Papers

BusinessVault prepares books-based GSTR-1, Purchase Register / Books ITC and
Draft GSTR-3B working papers. These are not filed returns, official GST Portal
statements, GSTN upload files, or a calculation of final statutory GST payable.
One Business record represents one GST registration. Purchase ITC requires
eligibility review and reconciliation with GST Portal data by the taxpayer/CA.

## Architecture

`GstMonthlyReportService` owns source loading, calculation, hashing and durable
reviews. `src/db/repos/gstReporting.ts` loads business-scoped sources using
start-inclusive, next-period-start-exclusive date indexes, plus specifically
linked historical documents for notes, amendments and ITC reversals/reclaims.
`calculateMonthlyGst.ts` is the deterministic calculation engine; `types.ts`
defines its normalized `MonthlyGstCalculation` contract. Each selected month is
calculated independently, including for QRMP registrations.

`exports.ts` consumes only `MonthlyGstCalculation[]`. It neither imports a
database/repository/service nor recalculates GST, aggregates converted rupees,
creates journal events, saves reviews, or changes report status. Overview,
Monthly Summary and Reconciliation reflect the supplied engine results. A stale
or corrupted result is not repaired by an exporter: recalculate through the
service before export. Additional EXPORT-origin controls sum actual presentation
rows in integer paise against normalized controls without replacing ENGINE-origin
reconciliations or source totals. Tests independently sum reopened spreadsheet cells to
check presentation correctness, rather than making spreadsheet formulas the
engine.

The service APIs are:

- `loadWorkspace(businessId?, reviewSourceIds?)`: businesses, profiles, AATO,
  saved runs and specifically linked purchase/ITC review evidence.
- `calculateMonths(businessId, periodKeys, filingFrequency?)`: sorted monthly
  normalized results and source hashes in a read transaction.
- `saveProfile`, `setAato`, `saveDocumentMetadata`: version-checked sidecars.
- `reviewItc`: immutable ledger review, including linked reversal/reclaim checks.
- `addAdjustment`: immutable, reasoned integer-paise CA deltas.
- `saveReport(calculation, 'REVIEWED' | 'FINALIZED_WORKING')`: recomputes and
  verifies the live source hash/rules and blocks unresolved errors/variances.

Durable operations belong to the existing transaction/audit/sync-event system.
Saved workings use canonical JSON attachments, uploaded through the existing
attachment queue/provider abstraction. Finalized/reviewed snapshots are not
updated in place; subsequent calculations produce new runs with supersession
links. Downloads are unsaved presentation artifacts, not canonical backups.

## Versions And Recovery

The inspected branch uses logical snapshot schema **15** (`src/db/schema.ts`)
and highest Dexie version **18** (`src/db/database.ts`), not Dexie version 15.
Report calculation schema **1** and JSON envelope
`businessvault.gst-working.v1` are separate version namespaces.

The pure v14-to-v15 snapshot migration populates missing additive GST fields
with `null` on persisted invoice/purchase/return lines, document metadata, ITC
ledger, adjustments and report runs. Dexie 18 applies the corresponding local
backfill. Neither backfill rewrites historical monetary values. Existing GST
stores include profiles, AATO, metadata, report runs/rows, adjustments and ITC
ledger; portal-import/match stores are not proof that this module supplies
portal reconciliation.

Snapshot building, restore table specifications and event replay are maintained
by the persistence layer. `canonicalGstSources` normalizes nullable fields and
key-sorts arrays for hashing; operational provider linkage and number allocators
are excluded from business evidence. Exporting needs no schema migration or
restore handler. Recovery verification must include the persistence suite; the
export tests alone do not establish Drive-only disaster recovery correctness.

### File Map And Migration Sequence

| Exact path | Responsibility |
| --- | --- |
| `src/domain/gstReporting/types.ts` | Fixed-point results, previous amendment line/header snapshots and source identities |
| `src/domain/gstReporting/periods.ts` | Date-only validation, FY/month/quarter boundaries and unique selected months |
| `src/domain/gstReporting/rules.ts` | Date-effective B2CL and AATO/HSN registry |
| `src/domain/gstReporting/documentSeries.ts` | Prefix/type grouping, leading-zero ranges, duplicates and gap ranges |
| `src/domain/gstReporting/calculateMonthlyGst.ts` | Normalization, classification, ITC, 3B, issues and reconciliations |
| `src/domain/gstReporting/GstMonthlyReportService.ts` | Transactions, source hashing, sidecar writes and immutable saved runs |
| `src/domain/gstReporting/index.ts` | UI service facade and device resolution |
| `src/db/repos/gstReporting.ts` | Business/date-scoped reads and linked historical evidence |
| `src/db/types.ts`, `src/db/schema.ts`, `src/db/database.ts` | Persisted types, logical schema 15, stores/indexes and Dexie 18 upgrade |
| `src/db/migrations/index.ts` | Pure v14-to-v15 migration and shared `GST_V15_NULL_FIELDS` |
| `src/domain/InvoiceService.ts`, `src/domain/PurchaseService.ts`, `src/domain/SalesReturnService.ts` | Capture/preserve historical line GST snapshots |
| `src/domain/legacyReversalMigration.ts` | Legacy reversal/return classification evidence |
| `src/domain/syncEventLog.ts`, `src/sync/buildSnapshotInput.ts` | GST event entities and CSV snapshot production |
| `src/restore/tableSchema.ts`, `src/restore/eventHandlers.ts`, `src/restore/rebuildFromDrive.ts` | Nullable CSV coercion, idempotent aggregate replay, attachment verification and recovery |
| `src/drive/GoogleDriveStorageProvider.ts` | Existing provider attachment/report backup paths, outside the calculation/export boundary |
| `src/ui/reports/GstSummaryPage.tsx`, `src/ui/pages/Reports.tsx` | Monthly GST workspace and navigation |
| `src/ui/invoices/InvoiceForm.tsx`, `src/ui/purchases/PurchasesPage.tsx` | Source line taxability capture/preservation |
| `src/domain/gstReporting/exports.ts`, `src/domain/gstReporting/exports.test.ts` | Presentation-only downloads and independent export verification |
| `docs/gst-reporting.md`, `docs/fixtures/gst-working-example.json`, `.gitignore` | Operating documentation, synthetic example and private-fixture exclusions |

Upgrade existing local databases from Dexie 17 to 18 using `STORES_V15` and the
shared nullable defaults. Restore older snapshots through the pure migration
chain before CSV coercion/writes; do not reuse Dexie versions or equate its
version with snapshot/report schema versions. Restore the selected business's
GST stores, replay post-snapshot events idempotently, verify canonical attachment
bytes/checksums, rebuild derived caches and recalculate/hash source evidence.
Missing old fields stay unknown, not historically inferred money. The export
layer requires no additional migration, DB write or replay event.

## Rules And Source Fidelity

The versioned registry is `rules.ts`, currently
`businessvault-gst-2025.05-v1`. Legal references are stored with its rules.
Thresholds must not be duplicated in presentation code.

- Before 1 August 2024, interstate unregistered B2CL uses invoice value strictly
  greater than INR 250,000 (25,000,000 paise).
- From 1 August 2024, the threshold is strictly greater than INR 100,000
  (10,000,000 paise).
- From May 2025, outward HSN summaries are split by B2B/B2C, with document-series
  readiness checks.
- Unknown preceding-FY AATO blocks readiness; valid complete 8-digit HSN codes
  are retained. Persisted description, rate and UQC snapshots take priority over
  current masters; missing historical detail requires review.
- Non-empty invalid GSTIN is unclassified and blocking, never treated as B2C or
  automatically approved ITC. Empty GSTIN and UIN are separate concepts.
- Source header totals include persisted round-off once. Rate/HSN amounts exclude
  header round-off. Credit notes and purchase returns already carry signed
  effects; exporters must never negate them again.

`HSN_RULE.thresholdPaise` is exactly `5_000_000_000` paise (INR 5 crore).
Confirmed preceding-FY AATO at or below that value requires at least 4 digits;
strictly above it requires at least 6 digits. Full valid 8-digit codes remain
unchanged. Rule descriptions and notification references are not a substitute
for CA/legal verification.

### Classification Decisions

| Captured evidence | Engine decision |
| --- | --- |
| Valid GSTIN, ordinary taxable domestic supply | B2B |
| Empty GSTIN, intrastate taxable supply | B2CS |
| Empty GSTIN, interstate, value equal to/below date-effective threshold | B2CS |
| Empty GSTIN, interstate, value strictly above date-effective threshold | B2CL |
| Non-empty invalid GSTIN | UNCLASSIFIED_INVALID_GSTIN; blocking, not B2C/approved ITC |
| Explicit export + OVERSEAS recipient + shipping bill number/date/port | Export with/without payment; without-payment tax must be zero |
| Explicit SEZ + SEZ recipient + valid GSTIN + interstate evidence | SEZ with/without payment; not ordinary B2B |
| Explicit deemed export with registered recipient | DEEMED_EXPORT |
| Explicit compatible zero-tax NIL_RATED / EXEMPT / NON_GST | Separate respective category; zero rate alone is insufficient |
| Explicit inward reverse charge | RCM liability, separately reviewed RCM ITC |
| Valid ECO GSTIN + SECTION_9_5 reporting + consistent role | ECO_9_5_SUPPLIER or ECO_9_5_LIABLE; no duplicate ordinary liability |
| Valid ECO GSTIN + ORDINARY reporting | Ordinary supply retaining ECO dimension |
| UIN or UNKNOWN recipient / outward reverse charge | Unclassified and blocking; not supported filing output |
| Supported same-group amendment with complete prior header/line snapshots | Current-period differential = amended minus previously reported |
| Amendment changes rate, HSN, description, UQC, goods/service or taxability | Excluded from totals, blocking; separate old/new group allocation not implemented |

Same-period `SAME_PERIOD_GSTR1A` requires original period equal to reporting
period; `OLDER_PERIOD_AMENDMENT` requires an earlier original period.
`INTERNAL_UNFILED_EDIT` is not an amendment to a filed working. Notes retain their
own return/reporting month and inherit only appropriate original classification
evidence. No category is inferred from party names or foreign-looking addresses.

### Inclusion Decisions

| Source condition | Tax totals and evidence |
| --- | --- |
| Live non-draft posted invoice/bill, posted native return | Included subject to validation; signed note effects applied once |
| Draft, deleted, superseded, edit-reversal/unknown legacy artifact | Excluded; normalized register/manifest evidence retained when available |
| True cancellation | No tax inclusion; applicable outward document series retained |
| Settlement cancellation proven by full posted native return | Original supply retained; return reduces it in its own period |
| Exact duplicate legal document identity | Every duplicate excluded, not an arbitrary winner; blocking issue and series evidence |
| Missing line data or classification detail | Review evidence remains; blocking and INCOMPLETE, no invented rate allocation |
| Invalid/missing prior amendment snapshots | Full amended amount excluded; blocking issue |
| Aggregate expense tax | Excluded from approved ITC; INSUFFICIENT_GST_DETAIL warning |
| Advance with applicability unknown/true but insufficient tax/application detail | Excluded and blocking; explicit not-applicable metadata avoids invented liability |
| Purchase tax without valid review | UNREVIEWED, approved ITC zero |

`included` is an engine inclusion flag, not certification of filing readiness:
an included unclassified row can appear in books totals and still block a review.
Rows outside the reporting period may exist only as linked context, not as new
current-month purchases or invoice totals.

### Fixed-Point Invariants

Money is safe integer paise, quantity safe integer micros, and rates integer
basis points. The engine validates business ownership and reporting period before
using source evidence. Header and persisted line invariants are:

```text
sum(line.taxable_paise) = header.taxable_paise
sum(line.<tax-head>_paise) = header.<tax-head>_paise
line.line_total_paise = line.taxable_paise + IGST + CGST + SGST + cess
header.pre_round_total_paise = taxable + IGST + CGST + SGST + cess
header.total_paise = header.pre_round_total_paise + header.round_off_paise
positive supply effect = +abs(source component)
credit/return effect = -abs(source component)
net book movement = gross + signed notes
amendment differential = amended - previously reported
Books ITC / calculated 4(C) = calculated 4A - calculated 4B
final working 4(C) = adjusted final 4A - adjusted final 4B
```

Round-off is a separate signed persisted component, never allocated to tax/HSN
rows or rounded again. A legacy negative return is normalized once, not subtracted
twice. Rate-row count is not document count. Header invoice/bill/note values are
counted once per source document; distinct valid identifiers determine party
counts. Reclaims require earlier matching temporary reversals and cannot exceed
remaining balances; purchase-return ITC effects require relevant review evidence.
Blocking mismatch/overflow issues must not be interpreted as repaired amounts.

## GSTR-3B Mappings

These mappings are supplied by the engine, not inferred by exporters:

| Working field | Captured source category |
| --- | --- |
| 3.1(a) | B2B, B2CL, B2CS, deemed export |
| 3.1(b) | Explicit exports and SEZ |
| 3.1(c) | Explicit nil-rated and exempt outward |
| 3.1(d) | Explicit inward RCM |
| 3.1(e) | Explicit non-GST outward |
| 3.1.1(i)/(ii) | ECO liable / supplier under section 9(5) |
| 3.2 | State-wise interstate unregistered/composition source working; UIN metadata currently blocked |
| 4(A)(1)-(5) | Reviewed IMPORT_GOODS, IMPORT_SERVICES, RCM, ISD, OTHER_ITC |
| 4(B)(1)/(2) | Permanent / temporary reversals |
| 4(C) | Net approved Books ITC |
| 4(D)(1)/(2) | Earlier reversal reclaims / ineligible ITC disclosure working |
| 5.NIL_EXEMPT.INTRASTATE | Explicit nil-rated/exempt inward, intrastate taxable value |
| 5.NIL_EXEMPT.INTERSTATE | Explicit nil-rated/exempt inward, interstate taxable value |
| 5.NON_GST.INTRASTATE | Explicit non-GST inward, intrastate taxable value |
| 5.NON_GST.INTERSTATE | Explicit non-GST inward, interstate taxable value |
| 5.1, 6.1 | NOT_AVAILABLE unless reasoned external/manual CA amounts supplied |

Books, GSTR-1 working, approved ITC, calculated amount, CA delta and final working
remain separate columns. CA adjustments preserve their IDs and reasons. Cash
ledger, credit ledger, payment allocation, interest, late fees and statutory
cross-utilization are not fabricated from local books.
Final 4(C) follows adjusted 4A minus 4B and retains contributing adjustment IDs;
a conflicting direct 4(C) delta is `TABLE4_FINAL_NET_CONFLICT`, not silently
accepted. Books-derived amounts remain unchanged. Table 5 codes above are the
current engine keys; the previous `5.INTERSTATE`/`5.INTRASTATE` aggregate keys are
not supported adjustment targets.

## Validation Codes

Issues retain severity, period, source type/ID, optional document/field, message,
recommended correction and optional integer-paise impact. This inventory mirrors
the inspected engine, including conditional document-series codes. Service input
rejections are thrown errors before writes, not additional engine issue codes.

| Severity / concern | Exact codes |
| --- | --- |
| BLOCKING_ERROR: scope/rules/profile | INVALID_PERIOD_SCOPE, INVALID_BUSINESS_GSTIN, GST_PROFILE_NOT_READY, AATO_UNKNOWN, RULE_NOT_AVAILABLE |
| BLOCKING_ERROR: duplicate identity | DUPLICATE_SOURCE_ID, DUPLICATE_LINE_ID, DUPLICATE_METADATA, DUPLICATE_DOCUMENT |
| BLOCKING_ERROR: source completeness | INVALID_DOCUMENT_DATE, INVALID_REPORTING_PERIOD, MISSING_PARTY, MISSING_DOCUMENT_NUMBER, MISSING_LINE_DATA |
| BLOCKING_ERROR: fixed-point/invariants | UNSAFE_MONEY, UNEXPECTED_NEGATIVE_AMOUNT, HEADER_TOTAL_MISMATCH, UNSAFE_LINE_VALUE, INVALID_LINE_SIGN, LINE_TOTAL_MISMATCH, LINE_HEADER_MISMATCH, UNSAFE_AGGREGATE, UNSAFE_QUANTITY_AGGREGATE |
| BLOCKING_ERROR: classification | INVALID_PARTY_GSTIN, UNSUPPORTED_DOCUMENT_TYPE, SEZ_CLASSIFICATION_REQUIRED, RETURN_CLASSIFICATION_CONFLICT, MISSING_PLACE_OF_SUPPLY, SUPPLIER_STATE_REQUIRED, SUPPLY_TYPE_CONFLICT, TAX_HEAD_CONFLICT, UNSUPPORTED_RECIPIENT, SPECIAL_SUPPLY_METADATA_REQUIRED, WITHOUT_PAYMENT_HAS_TAX, OUTWARD_RCM_REVIEW_REQUIRED, UNKNOWN_TAXABILITY, TAXABILITY_CONFLICT, INVALID_HSN, MISSING_UQC, MIXED_TAXABILITY_REVIEW, AMENDMENT_PREVIOUS_VALUES_REQUIRED, UNSUPPORTED_CLASSIFICATION, ADVANCE_GST_DETAIL_REQUIRED |
| BLOCKING_ERROR: ITC | RECLAIM_EXCEEDS_BALANCE, ITC_REVIEW_INVALID, DUPLICATE_ITC_REVIEW, ITC_SOURCE_NOT_INCLUDED, PURCHASE_RETURN_ITC_REVIEW_REQUIRED, ITC_CUMULATIVE_ENTITLEMENT_EXCEEDED, ITC_CUMULATIVE_BALANCE_INVALID |
| BLOCKING_ERROR: working controls | DOCUMENT_SERIES_DUPLICATE, DOCUMENT_SERIES_REQUIRED, INVALID_CA_ADJUSTMENT, UNSAFE_CA_ADJUSTMENT, TABLE4_FINAL_NET_CONFLICT, RECONCILIATION_VARIANCE |
| WARNING | AATO_USER_CONFIRMED, LEGACY_NEGATIVE_NOTE, MISSING_ORIGINAL_NOTE_LINK, INFERRED_LINE_SNAPSHOT, ITC_UNREVIEWED, BOOKS_ITC_PORTAL_RECONCILIATION_REQUIRED, INSUFFICIENT_GST_DETAIL, DOCUMENT_SERIES_REVIEW, MANUAL_CA_ADJUSTMENT, NIL_PERIOD_NOT_CONFIRMED |
| INFORMATION | RULE_SET, FULL_NATIVE_RETURN_ORIGINAL_RETAINED |

Reconciliation codes are `OUTWARD_RATE_HEADERS`, `INWARD_RATE_HEADERS`,
`OUTWARD_HSN_LINES`, `INWARD_HSN_LINES`, `GSTR1_SECTION_TOTALS`, `GSTR1_TO_3B`,
`PURCHASE_GROSS_NOTES_NET`, `PURCHASE_TAX_ITC_LEDGER`, `APPROVED_ITC_TO_3B`,
`TABLE4_A_MINUS_B`, `TABLE4_FINAL_A_MINUS_B` and `DOCUMENT_SERIES_COUNT`.
They compare engine source/working amounts, counts and safe integer variances;
rate/HSN checks exclude header round-off and document-series checks compare counts.
Export tests additionally check the cells actually written. Reconciliation keeps
ENGINE-origin controls unchanged and adds EXPORT-origin controls for detail
sections/row kinds, unique identities, row counts, taxable/tax heads, note/header
values, HSN, ITC partitions/movements, 3B fields/liabilities, document-series counts
and issue impacts. Null external figures stay null. Overflow or differing
amounts/counts produce ERROR, not repaired totals or a silently upgraded status.

## Export APIs

All functions take `MonthlyGstCalculation[]` and are exported by
`src/domain/gstReporting/exports.ts`:

```ts
buildMonthlyGstWorkbook(results): Promise<{
  blob: Blob;
  xlsxBuffer: ArrayBuffer;
  filename: string;
}>
downloadMonthlyGstExcel(results): Promise<void>
downloadMonthlyGstCsv(results): Promise<void>
downloadMonthlyGstJson(results): Promise<void>
downloadMonthlyGstPdf(results): Promise<void>
```

Empty selections, duplicate months, quarter calculations and mixed business
registrations/filing frequencies are rejected. Inputs are not sorted/mutated in
place. Incomplete calculations remain exportable for review. Unsafe monetary
values fail rather than becoming zero, NaN or Infinity.

The consolidated workbook contains exactly these 18 sheets, in this order:

`Overview`, `Monthly Summary`, `Sales Register`, `G1 B2B`, `G1 B2CL`, `G1 B2CS`,
`G1 Other`, `Sales Notes`, `HSN B2B`, `HSN B2C`, `Documents`, `Purchase Register`,
`Purchase Returns`, `Books ITC`, `GSTR3B Working`, `Issues`, `Reconciliation`,
`Metadata`.

Every row carries Tax Period. Monthly Summary includes gross/notes/net movement,
GSTR-1 section summaries, ITC status buckets, output/RCM liability and indicative
balance. G1 Other retains all other engine section keys, including notes,
amendments, nil/exempt/non-GST and unclassified supplies. It is not a claim that
all possible statutory categories have been validated as nil.

Sales Register contains each normalized source document, including exclusions;
filter `included = true` for reconciliation with included monthly totals. Sales
Notes and Purchase Returns are drill-down views of those same documents, not
additional values to add to an already-net register. Do not sum overlapping
summary sections or sheets together.

Purchase Register uses `row_kind = DOCUMENT | RATE | HSN` to retain inward
document, rate and purchase-HSN evidence within the fixed 18-sheet contract.
Filter a single row kind before summing taxable/tax columns; only DOCUMENT rows
contain header bill value and round-off. Outward rate sheets intentionally have
no repeated invoice-value or round-off columns. Their `pre_round_total` is the
rate contribution, not the invoice value. All source and line IDs are retained.
Historical COMBINED and UNCLASSIFIED HSN rows appear in HSN B2B with an explicit
recipient_group; they are not relabelled B2B. HSN B2C retains B2C rows.

Money is validated integer paise and converted using the existing money helper
only at the boundary: numeric INR cells with two-decimal formatting in XLSX,
exact two-decimal INR strings in CSV/PDF. XLSX identifiers are text, dates are
real UTC date cells with `dd-mmm-yyyy`, rates are percentages and quantities have
up to six decimals. Existing CSV sanitization protects all spreadsheet strings;
source JSON evidence is preserved as JSON rather than spreadsheet-escaped.
Headers are frozen, filters/widths set and warnings/errors styled.

CSV downloads one file per workbook sheet (18 files), covering all 11 required
detail categories plus overview, monthly summary and metadata. CSV has no cell
types: quoted fields cannot force Excel's automatic import to retain leading
zeros. Use Excel's Text import type for identifiers, or prefer XLSX, which
explicitly retains them. Formula-like strings are apostrophe-guarded by the
existing helper, including negative money strings; the decimal digits remain
exact. Browsers may require permission for multiple automatic downloads.

Internal JSON retains integer paise, source manifest, rules, hashes, issues and
the disclaimer under schema `businessvault.gst-working.v1`. It is not GSTN JSON.
The paginated jsPDF summary shows month-wise movement, liability, ITC status
buckets, reversals/reclaims, adjustments, unavailable portal values and issues.
It supplements the registers rather than replacing them.

Metadata includes business, GSTIN, periods, frequency, generated time, app/report
versions, rules, source hashes, status and disclaimer. Frozen-service additions
`savedReportRunId` and `savedStatus` are retained as `saved_report_run_id` and
`saved_status`, and unchanged in JSON. Metadata `status` preserves saved status;
`calculation_status` and `export_status` separately expose original calculation and
presentation-validation states. Discrepancies make export_status and Overview
INCOMPLETE without mutating the saved result/history. Unsaved/old results leave
saved identity blank; exporting does not create a saved review.

G1 B2CS consumes `gstr1Sections.b2csAggregates` when present instead of individual
rate rows, retaining all contributing source entity IDs/types and line IDs.
Period/POS/rate/supply-type/ECO grouping is supplied by the engine. Older frozen
v1 results without aggregates retain the original rate view; exports do not
reconstruct or classify aggregates. Captured shipping bill number/date, port,
section 9(5) role, section 52 flag and ECO reporting type remain visible in
document/section columns; missing values stay blank.

`ITC_PARTITION:<status>` summary rows are mutually exclusive current-month book
tax partitions. `ITC:<status>` rows are movements or balances, not another
partition to sum together. Eligibility movement excludes separately reported
reclaims. Outstanding reclaimable tax is a balance, not a repeated claim.

### General Workbook Compatibility

`src/excel/excelExport.ts` preserves the `GST Summary` sheet name and public
business export API but replaces the divergent line/slab engine with
`GstMonthlyReportService` using the caller's existing `options.db`. Months
intersecting fromDate/toDate are calculated independently, respecting captured
filing frequency, with six gross/notes/net sales/purchase rows and engine
counts/status/hash. Slab columns are intentionally replaced with normalized
monthly columns rather than preserving an incorrect legacy calculation. The
scope note explicitly says boundary months are complete calendar months, not
an exact-date GST period. Other business workbook sheets retain existing scopes.
Open GST Reports for complete registers, issues and reconciliation.

## Limitations And CA Caveats

The legacy paths exposed historical defects such as invalid-GSTIN-to-B2C
fallback, date-insensitive B2CL boundaries, rupee-valued aggregation, repeating
mixed-rate invoice values/counts, current-master historical substitutions,
header-derived note rates and filing-looking purchase/JSON labels. The monthly
path separates these responsibilities and tests their controls; this is not a
claim that every legacy/general report is now corrected. The earlier AATO paise
discrepancy is corrected in the current registry, and Table 5 no longer combines
nil/exempt with non-GST. Remaining concrete presentation constraints are CSV
import typing, PDF font coverage, extreme Excel precision and missing saved-run
identity on older calculation DTOs; see the caveats below.

- Composition/unregistered/unsupported registration types must not be treated
  as regular filing workings; review the engine issues and source status.
- Advances lacking applicability/application tax detail are blocked; aggregate
  expense tax is excluded from approved ITC with an issue.
- UIN recipient validation/reporting and outward RCM liability are unsupported:
  `UNSUPPORTED_RECIPIENT` and `OUTWARD_RCM_REVIEW_REQUIRED` block readiness, with
  unclassified evidence retained. A modeled UIN enum or 3.2 filter is not support.
- Attribute-changing amendments lack separate old/new grouping; complete prior
  header and line snapshots with unchanged grouping attributes are required.
  Unsupported changes are excluded and `AMENDMENT_PREVIOUS_VALUES_REQUIRED`
  blocks review. Mixed-taxability documents likewise require allocation not
  implemented in this phase. These are deliberate safety boundaries, not proof
  that every requirement in the implementation prompt is complete.
- Legacy returns without line detail, unsupported metadata and unsafe/mismatched
  amounts remain issues; exports do not invent allocations or repair evidence.
- QRMP exports remain monthly internal analysis, not separately filed quarterly
  returns. No quarter filing, IFF upload or direct portal workflow is provided.
- jsPDF's standard Helvetica font is limited for non-Latin taxpayer names.
  XLSX/CSV/JSON preserve Unicode; a separately reviewed embedded-font solution
  is needed for full multilingual PDF rendering.
- XLSX money must be within absolute `999_999_999_999_999` paise
  (INR `9_999_999_999_999.99`, 15 decimal digits including paise) and satisfy
  `Math.round(Number(exactRupeeString) * 100) === originalPaise`. JavaScript-safe
  values such as `9007199254740893` paise are rejected with an actionable CSV/JSON
  alternative instead of silently losing paise. Both signs are checked.
- The legacy `gstrExport.ts` remains a separate
  path. Its current-master UQC fallbacks, mixed-rate handling and labels
  must not be assumed to inherit fixes from the monthly engine. The monthly
  module is the source of truth for this pack. The workspace now uses the service
  facade and named monthly export functions; other legacy export routes
  do not automatically inherit the monthly calculation's guarantees.
- Filing readiness, zero unexplained engine variances and an export do not prove
  completeness of taxpayer books, portal matching or filing. An empty local
  month is not automatically a confirmed nil return.

## Synthetic Example

[`fixtures/gst-working-example.json`](fixtures/gst-working-example.json) is a
hand-authored deterministic presentation fixture in the internal JSON envelope.
All IDs/names and amounts are invented. `SYNTHETIC-NOT-A-GSTIN` is intentionally
not a real/valid GSTIN; the example is INCOMPLETE and not suitable for filing,
finalization or production import. Its source hash is explicitly a placeholder,
not a computed source fingerprint. It illustrates one unregistered sale of
100 paise taxable value, 18 paise IGST, 118 paise invoice value, no purchases,
separate Table 5 rows, and unavailable external figures. Only representative
3B/reconciliation rows are shown; it is not an engine-generated complete return.
The export test reads this fixture, reopens its workbook, and round-trips the JSON
download without writing artifacts. Never derive public fixtures from taxpayer
samples. Keep private samples under the ignored fixture directories instead.

## Verification

`exports.test.ts` uses synthetic normalized fixtures and reopens generated XLSX
in a separate ExcelJS workbook. It checks monthly register/rate/HSN sums,
round-off, unique header values, inward row-kind sums, ITC, adjustment and
unavailable cells, exact sheet names, styles, UTC dates, identifiers, injection,
source IDs, CSV detail coverage, JSON paise, PDF pagination and input failures.
It also exercises one-paise rows and exact large-value CSV output. These tests
generate artifacts in memory only.

| Test file | Coverage responsibility |
| --- | --- |
| `src/domain/gstReporting/periods.test.ts` | Calendar dates, monthly/QRMP boundaries, date-effective B2CL and INR 5 crore AATO boundary |
| `src/domain/gstReporting/documentSeries.test.ts` | Prefix/type grouping, leading zeros, gaps/duplicates, bounded gap ranges |
| `src/domain/gstReporting/calculateMonthlyGst.test.ts` | Inclusion/signs, mixed rates/returns, classification, historical fidelity, amendment differentials/blocked attributes, effective ITC periods, adjusted 4C, split Table 5, isolation/determinism and 50k outward + 50k inward lines |
| `src/domain/gstReporting/GstMonthlyReportService.test.ts` | Actual Dexie 17-to-18 upgrade, read-only/event boundaries, guarded writes, canonical saved JSON, idempotent child replay, provider-only recovery and hashes |
| `src/domain/gstReporting/exports.test.ts` | Independent XLSX sums/types, CSV/JSON precision, PDF pagination, split Table 5/adjusted 4C and blocked-result visibility, synthetic documented fixture |
| `src/excel/excelExport.test.ts` | Preserved GST Summary sheet with monthly service calls using the caller's DB and explicit full-month boundary scope |
| `src/db/migrations/index.test.ts`, `src/restore/tableSchema.test.ts`, `src/restore/rebuildFromDrive.test.ts` | Pure migrations/nullable CSV behavior, attachment verification and replay/restore regression paths |
| `src/ui/reports/GstSummaryPage.test.tsx` | Workspace service/export wiring and user flows, not legal certification |

Suite sizes change during implementation. Do not treat a prior whole-repository
test count as a current verification result. The previously reported main-run
baseline is historical user-provided evidence, not a run performed for this
documentation update. Record commands and actual results at
handoff; do not claim browser multi-download permissions, PDF Unicode rendering,
live Drive recovery or unsupported statutory categories were verified by unit
tests. The existence of a test in this matrix is not a statement that it passed.

Verification is recorded in the implementation handoff with the actual command
results for that run. Do not carry forward a typecheck pass from an earlier
revision: concurrent UI/service/engine changes may temporarily block integration.
The full main suite, live browser downloads and live Drive recovery are not
implied by the focused export/general-Excel tests.

## Requirement Coverage Matrix

This matrix covers every numbered area of the implementation prompt. It identifies
responsibilities and deliberately partial/blocked areas rather than asserting
all requirements are complete. The main implementation audit owns end-to-end
completion evidence; this export/documentation scope does not replace that audit.

| Prompt section | Implementation / evidence / remaining boundary |
| --- | --- |
| 1 Product outcome | Monthly books-based workspace and XLSX/CSV/JSON/PDF; not filing/portal statements |
| 2 Repository inspection | File map, version inspection and documented legacy risks; current whole-app audit remains main-owner work |
| 3 Architecture | Service/repository/engine split; exports pure presentation except fixed-point output checks; durable writes remain transaction/event-owned |
| 4 Safety defects | Monthly engine sign/date/GSTIN/count/snapshot controls; general GST slab engine replaced; legacy standalone exporter remains separate |
| 5 Period model | Canonical month/FY and QRMP analysis; multi-month exports remain independent; no IFF/quarter filing |
| 6 Rule registry | B2CL date decisions, INR 5 crore AATO, May HSN/documents; legal references require CA review |
| 7 Data model | Profiles/AATO/metadata/ITC/adjustments/runs, nullable line snapshots, logical15/Dexie18; one business per registration |
| 8 Single result | Normalized monthly results, frozen saved identity/status, source hash; export verification never repairs engine totals |
| 9 Money/signs | Integer-paise controls, separate round-off, no rupee aggregation; XLSX precision guard with CSV/JSON alternative |
| 10 Inclusion | Draft/cancelled/deleted/reversal/duplicate and context rules; notes/reporting overrides remain period-specific |
| 11 GSTR-1 | B2B/B2CL/B2CS aggregate + Other/notes/HSN/documents; UIN, outward RCM, attribute-changing amendments and insufficient advances blocked |
| 12 Purchase/ITC | Gross/notes/net register and HSN row kinds, status book-tax partitions versus movements/balances; no automatic eligibility/portal matching |
| 13 Draft 3B | Captured 3.1/3.1.1/3.2, ITC, adjusted 4C, separate Table5; external 5.1/6.1 unavailable except reviewed manual inputs |
| 14 Reconciliation | Original ENGINE controls + actual EXPORT row/count/amount controls; ERROR causes export_status INCOMPLETE without altering saved review status |
| 15 Validation | Exact severity/code inventory above; blocking evidence is not hidden or certified nil |
| 16 UI | Workspace/service/export integration owned by UI agent; saved service must provide frozen calculations, not live replacements |
| 17 Excel | Exact 18 sheets, period columns, identifiers/date cells, fixed-point boundary conversion, filters/freeze/metadata; no portal-upload claim |
| 18 CSV/PDF/JSON | Detailed CSV files, paginated summary, integer-paise internal schema; CSV import typing and PDF Unicode font limitations explicit |
| 19 Privacy | Deterministic invented public fixture, deliberately invalid GSTIN; private fixture directories ignored; no taxpayer samples copied |
| 20 Tests | Export reopen/sums, precision rejection, saved metadata, B2CS, special fields, 46/45+1/15 and 5/3 synthetic integration; engine/persistence/restore/UI suites separately owned |
| 21 Phases | Phased changes span multiple owners; focused export verification is not a claim all phases/statutory categories are complete |

Run `npm test -- src/domain/gstReporting/exports.test.ts` for export checks and
`npm run typecheck` for integration. Run the engine, service and restore suites
separately for their guarantees. This document describes test coverage, not an
assertion that every repository test or disaster-recovery scenario was run.
