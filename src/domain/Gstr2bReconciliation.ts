import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db/database';
import type { Gstr2bDocument, GstMatch, Purchase, Supplier } from '../db/types';
import { pokeSyncWorker } from '../sync/pokeChannel';
import { appendSyncEvent } from './syncEventLog';

export interface PurchaseRegisterDocument {
  purchase: Purchase;
  supplier: Supplier | null;
  includeBooksOnly?: boolean;
}

export interface Gstr2bMatchProposal {
  gstr2bDocumentId: string | null;
  bookSourceId: string | null;
  bookSourceType?: string | null;
  status: GstMatch['status'];
  confidenceBps: number;
  taxableDifferencePaise: number | null;
  igstDifferencePaise: number | null;
  cgstDifferencePaise: number | null;
  sgstDifferencePaise: number | null;
  cessDifferencePaise: number | null;
}

export interface Gstr2bReconciliationOptions {
  probableDateToleranceDays?: number;
  probableAmountTolerancePaise?: number;
  exactAmountTolerancePaise?: number;
}

export interface ReconcileImportInput extends Gstr2bReconciliationOptions {
  businessId: string;
  deviceId: string;
  importId: string;
}

const TAX_FIELDS = [
  ['taxable_paise', 'taxableDifferencePaise'],
  ['igst_paise', 'igstDifferencePaise'],
  ['cgst_paise', 'cgstDifferencePaise'],
  ['sgst_paise', 'sgstDifferencePaise'],
  ['cess_paise', 'cessDifferencePaise'],
] as const;

function normalizedDocumentNumber(value: string | null): string {
  return (value ?? '').normalize('NFKC').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizedDocumentType(value: string | null): string {
  const type = (value ?? '').trim().toUpperCase();
  if (type === 'TAX_INVOICE') return 'INVOICE';
  if (type === 'CREDIT_NOTE' || type === 'DEBIT_NOTE') return type;
  return type;
}

function documentYear(value: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(0, 4) : 'UNKNOWN';
}

function assertSafeMoney(value: number | null, label: string): void {
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be integer paise within the safe integer range`);
  }
}

function difference(portal: number | null, books: number): number | null {
  if (portal === null) return null;
  assertSafeMoney(portal, 'GSTR-2B amount');
  assertSafeMoney(books, 'Purchase Register amount');
  const result = portal - books;
  if (!Number.isSafeInteger(result)) throw new Error('GSTR-2B difference exceeds the safe integer range');
  return result;
}

function dateDistanceDays(left: string | null, right: string): number | null {
  if (!left || !/^\d{4}-\d{2}-\d{2}$/.test(left) || !/^\d{4}-\d{2}-\d{2}$/.test(right)) return null;
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) ||
    new Date(leftTime).toISOString().slice(0, 10) !== left ||
    new Date(rightTime).toISOString().slice(0, 10) !== right) return null;
  return Math.abs(leftTime - rightTime) / 86_400_000;
}

function isProbableNumberMatch(left: string, right: string): boolean {
  if (left.length < 5 || right.length < 5 || Math.abs(left.length - right.length) > 1) return false;
  let mismatches = 0;
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i++;
      j++;
      continue;
    }
    if (++mismatches > 1) return false;
    if (left.length > right.length) i++;
    else if (right.length > left.length) j++;
    else {
      i++;
      j++;
    }
  }
  return mismatches + (left.length - i) + (right.length - j) <= 1;
}

function makeProposal(
  portal: Gstr2bDocument | null,
  book: PurchaseRegisterDocument | null,
  status: GstMatch['status'],
  confidenceBps: number,
): Gstr2bMatchProposal {
  const proposal: Gstr2bMatchProposal = {
    gstr2bDocumentId: portal?.id ?? null,
    bookSourceId: book?.purchase.id ?? null,
    bookSourceType: book ? 'purchase' : null,
    status,
    confidenceBps,
    taxableDifferencePaise: null,
    igstDifferencePaise: null,
    cgstDifferencePaise: null,
    sgstDifferencePaise: null,
    cessDifferencePaise: null,
  };
  if (!portal || !book) return proposal;

  const purchase = book.purchase;
  const sources = {
    taxable_paise: [portal.taxable_paise, purchase.taxable_paise],
    igst_paise: [portal.igst_paise, purchase.igst_paise],
    cgst_paise: [portal.cgst_paise, purchase.cgst_paise],
    sgst_paise: [portal.sgst_paise, purchase.sgst_paise],
    cess_paise: [portal.cess_paise, purchase.cess_paise],
  } as const;
  for (const [field, target] of TAX_FIELDS) {
    const [portalValue, bookValue] = sources[field];
    proposal[target] = difference(portalValue, bookValue);
  }
  return proposal;
}

function classifyAmounts(
  proposal: Gstr2bMatchProposal,
  confidenceBps: number,
  amountTolerancePaise: number,
): Gstr2bMatchProposal['status'] {
  const { taxableDifferencePaise, igstDifferencePaise, cgstDifferencePaise, sgstDifferencePaise, cessDifferencePaise } = proposal;
  if (taxableDifferencePaise !== null && Math.abs(taxableDifferencePaise) > amountTolerancePaise) return 'VALUE_MISMATCH';
  if ([igstDifferencePaise, cgstDifferencePaise, sgstDifferencePaise, cessDifferencePaise]
    .some((amount) => amount !== null && Math.abs(amount) > amountTolerancePaise)) return 'TAX_HEAD_MISMATCH';
  if ([taxableDifferencePaise, igstDifferencePaise, cgstDifferencePaise, sgstDifferencePaise, cessDifferencePaise]
    .some((amount) => amount === null)) return 'PROBABLE_MATCH';
  return confidenceBps === 10_000 ? 'EXACT_MATCH' : 'PROBABLE_MATCH';
}

export function reconcileGstr2bDocuments(
  businessId: string,
  documents: readonly Gstr2bDocument[],
  purchaseRegister: readonly PurchaseRegisterDocument[],
  options: Gstr2bReconciliationOptions = {},
): Gstr2bMatchProposal[] {
  const dateTolerance = options.probableDateToleranceDays ?? 3;
  const amountTolerance = options.probableAmountTolerancePaise ?? 100;
  const exactAmountTolerance = options.exactAmountTolerancePaise ?? 0;
  if (!Number.isSafeInteger(dateTolerance) || dateTolerance < 0) throw new Error('Probable-match date tolerance must be a non-negative integer');
  if (!Number.isSafeInteger(amountTolerance) || amountTolerance < 0) throw new Error('Probable-match amount tolerance must be non-negative integer paise');
  if (!Number.isSafeInteger(exactAmountTolerance) || exactAmountTolerance < 0) throw new Error('Exact-match amount tolerance must be non-negative integer paise');

  if (!businessId) throw new Error('businessId is required');
  for (const document of documents) {
    if (document.business_id !== businessId) throw new Error('GSTR-2B document belongs to another business');
    for (const [field] of TAX_FIELDS) assertSafeMoney(document[field], `GSTR-2B ${field}`);
  }
  for (const { purchase, supplier } of purchaseRegister) {
    if (purchase.business_id !== businessId || (supplier && supplier.business_id !== businessId)) {
      throw new Error('Purchase Register row belongs to another business');
    }
    for (const field of ['taxable_paise', 'igst_paise', 'cgst_paise', 'sgst_paise', 'cess_paise'] as const) {
      assertSafeMoney(purchase[field], `Purchase Register ${field}`);
    }
  }
  const books = purchaseRegister.filter(({ purchase }) =>
    purchase.status !== 'cancelled' && !purchase.reverses_purchase_id &&
    !purchase.reversed_by_purchase_id && !purchase.replaces_purchase_id,
  );
  const returnBooks = purchaseRegister.filter(({ purchase }) =>
    purchase.status !== 'cancelled' && !!purchase.reverses_purchase_id,
  );
  const bookKeys = new Map<string, PurchaseRegisterDocument[]>();
  for (const book of books) {
    const number = normalizedDocumentNumber(book.purchase.supplier_bill_number);
    if (!number || !book.supplier?.gstin || book.purchase.reverses_purchase_id) continue;
    const key = `${book.supplier.gstin}|INVOICE|${number}|${documentYear(book.purchase.bill_date)}`;
    bookKeys.set(key, [...(bookKeys.get(key) ?? []), book]);
  }
  const portalKeys = new Map<string, Gstr2bDocument[]>();
  for (const document of documents) {
    const number = normalizedDocumentNumber(document.canonical_document_number);
    if (!number || !document.supplier_gstin || !document.document_type) continue;
    const key = `${document.supplier_gstin}|${normalizedDocumentType(document.document_type)}|${number}|${documentYear(document.document_date)}`;
    portalKeys.set(key, [...(portalKeys.get(key) ?? []), document]);
  }

  const proposals: Gstr2bMatchProposal[] = [];
  const usedBooks = new Set<string>();
  const usedDocuments = new Set<string>();
  for (const [key, portalRows] of portalKeys) {
    const booksForKey = bookKeys.get(key) ?? [];
    if (portalRows.length > 1) {
      for (const portal of portalRows) {
        proposals.push(makeProposal(portal, null, 'DUPLICATE_IN_GSTR2B', 0));
        usedDocuments.add(portal.id);
      }
      continue;
    }
    if (booksForKey.length > 1) {
      const portal = portalRows[0];
      for (const book of booksForKey) {
        const proposal = makeProposal(portal, book, 'DUPLICATE_IN_BOOKS', 0);
        proposals.push(proposal);
      }
      usedDocuments.add(portal.id);
      for (const book of booksForKey) usedBooks.add(book.purchase.id);
      continue;
    }
    if (booksForKey.length === 1) {
      const portal = portalRows[0];
      const book = booksForKey[0];
      const dateDiff = dateDistanceDays(portal.document_date, book.purchase.bill_date);
      const inDateTolerance = dateDiff !== null && dateDiff <= dateTolerance;
      const exactDate = dateDiff === 0;
      const confidenceBps = exactDate ? 10_000 : inDateTolerance ? 9_500 : 9_000;
      const proposal = makeProposal(portal, book, exactDate ? 'EXACT_MATCH' : inDateTolerance ? 'PROBABLE_MATCH' : 'DATE_MISMATCH', confidenceBps);
      if (inDateTolerance) proposal.status = classifyAmounts(proposal, confidenceBps, exactDate ? exactAmountTolerance : amountTolerance);
      if (!exactDate && proposal.status === 'EXACT_MATCH') proposal.status = 'PROBABLE_MATCH';
      if (!inDateTolerance) proposal.status = 'DATE_MISMATCH';
      proposals.push(proposal);
      if (!book.purchase.reversed_by_purchase_id && !book.purchase.replaces_purchase_id) usedBooks.add(book.purchase.id);
      usedDocuments.add(portal.id);
    }
  }

  for (const portal of documents) {
    if (usedDocuments.has(portal.id)) continue;
    const portalNumber = normalizedDocumentNumber(portal.canonical_document_number);
    if (normalizedDocumentType(portal.document_type) === 'CREDIT_NOTE' && portal.original_document_number) {
      const originalNumber = normalizedDocumentNumber(portal.original_document_number);
      const originalPurchase = books.filter((book) =>
        !book.purchase.reverses_purchase_id &&
        book.supplier?.gstin === portal.supplier_gstin &&
        normalizedDocumentNumber(book.purchase.supplier_bill_number) === originalNumber &&
        (!portal.original_document_date || documentYear(book.purchase.bill_date) === documentYear(portal.original_document_date)),
      );
      if (originalPurchase.length === 1) {
        const returnPurchase = returnBooks.find((book) => book.purchase.reverses_purchase_id === originalPurchase[0].purchase.id);
        if (returnPurchase) {
          proposals.push(makeProposal(portal, returnPurchase, 'CREDIT_NOTE_MISMATCH', 0));
          usedBooks.add(originalPurchase[0].purchase.id);
          usedBooks.add(returnPurchase.purchase.id);
          usedDocuments.add(portal.id);
          continue;
        }
      }
    }
    const sameNumber = portalNumber && normalizedDocumentType(portal.document_type) === 'INVOICE' ? books.filter((book) =>
      normalizedDocumentNumber(book.purchase.supplier_bill_number) === portalNumber &&
      documentYear(book.purchase.bill_date) === documentYear(portal.document_date)
    ) : [];
      const differentGstin = portal.supplier_gstin
      ? sameNumber.filter((book) => !!book.supplier?.gstin && book.supplier.gstin !== portal.supplier_gstin && !usedBooks.has(book.purchase.id))
      : [];
    if (differentGstin.length === 1) {
      const book = differentGstin[0];
      const proposal = makeProposal(portal, book, 'GSTIN_MISMATCH', 8_000);
      proposals.push(proposal);
      usedBooks.add(book.purchase.id);
      usedDocuments.add(portal.id);
      continue;
    }
    const creditNoteMismatch = normalizedDocumentType(portal.document_type) === 'CREDIT_NOTE' && portal.original_document_number
      ? books.filter((book) =>
        book.supplier?.gstin === portal.supplier_gstin &&
        normalizedDocumentNumber(book.purchase.supplier_bill_number) === normalizedDocumentNumber(portal.original_document_number) &&
        documentYear(book.purchase.bill_date) === documentYear(portal.original_document_date),
      )
      : [];
    if (creditNoteMismatch.length === 1) {
      const book = creditNoteMismatch[0];
      const returnPurchase = returnBooks.find((row) => row.purchase.reverses_purchase_id === book.purchase.id);
      proposals.push(makeProposal(portal, returnPurchase ?? book, 'CREDIT_NOTE_MISMATCH', 0));
      usedBooks.add(book.purchase.id);
      if (returnPurchase) usedBooks.add(returnPurchase.purchase.id);
      usedDocuments.add(portal.id);
      continue;
    }
    const differentType = portalNumber ? books.filter((book) =>
      book.supplier?.gstin === portal.supplier_gstin &&
      !book.purchase.reverses_purchase_id &&
      normalizedDocumentNumber(book.purchase.supplier_bill_number) === portalNumber &&
      documentYear(book.purchase.bill_date) === documentYear(portal.document_date) &&
      normalizedDocumentType(portal.document_type) !== 'INVOICE' &&
      !usedBooks.has(book.purchase.id),
    ) : [];
    if (differentType.length === 1) {
      const book = differentType[0];
      const proposal = makeProposal(portal, book, 'DOCUMENT_TYPE_MISMATCH', 8_000);
      proposals.push(proposal);
      usedBooks.add(book.purchase.id);
      usedDocuments.add(portal.id);
      continue;
    }
    const probable = books.filter((book) => {
      if (book.purchase.reverses_purchase_id) return false;
      if (!portal.supplier_gstin || (book.supplier?.gstin ?? '') !== portal.supplier_gstin) return false;
      if (normalizedDocumentType(portal.document_type) !== 'INVOICE') return false;
      const bookNumber = normalizedDocumentNumber(book.purchase.supplier_bill_number);
      const dateDiff = dateDistanceDays(portal.document_date, book.purchase.bill_date);
      if (!isProbableNumberMatch(portalNumber, bookNumber) || dateDiff === null || dateDiff > dateTolerance) return false;
      const taxDifferences = [
        difference(portal.taxable_paise, book.purchase.taxable_paise),
        difference(portal.igst_paise, book.purchase.igst_paise),
        difference(portal.cgst_paise, book.purchase.cgst_paise),
        difference(portal.sgst_paise, book.purchase.sgst_paise),
        difference(portal.cess_paise, book.purchase.cess_paise),
      ];
      return taxDifferences.every((taxDifference) => taxDifference === null || Math.abs(taxDifference) <= amountTolerance);
    }).filter((book) => !usedBooks.has(book.purchase.id));
    if (probable.length === 1) {
      const book = probable[0];
      const proposal = makeProposal(portal, book, 'PROBABLE_MATCH', 7_500);
      proposal.status = classifyAmounts(proposal, 7_500, amountTolerance);
      if (proposal.status === 'EXACT_MATCH') proposal.status = 'PROBABLE_MATCH';
      proposals.push(proposal);
      usedBooks.add(book.purchase.id);
    } else {
      proposals.push(makeProposal(portal, null, 'GSTR2B_ONLY', 0));
    }
    usedDocuments.add(portal.id);
  }

  for (const book of books) {
    if (book.includeBooksOnly !== false && !usedBooks.has(book.purchase.id)) {
      proposals.push(makeProposal(null, book, 'BOOKS_ONLY', 0));
    }
  }
  return proposals;
}

export class Gstr2bReconciliationService {
  constructor(private readonly db: BusinessVaultDB) {}

  async reconcileImport(input: ReconcileImportInput): Promise<GstMatch[]> {
    if (!input.businessId || !input.deviceId || !input.importId) {
      throw new Error('businessId, deviceId and importId are required');
    }

    const now = new Date().toISOString();
    let matches: GstMatch[] = [];
    await this.db.transaction(
      'rw',
      [this.db.gstr2b_imports, this.db.gstr2b_documents, this.db.purchases, this.db.suppliers,
        this.db.gst_matches, this.db.audit_log, this.db.sync_events],
      async () => {
        const imported = await this.db.gstr2b_imports.get(input.importId);
        if (!imported || imported.business_id !== input.businessId) {
          throw new Error('GSTR-2B import not found for this business');
        }
      if (imported.parse_status !== 'PARSED') {
        throw new Error('Only a successfully parsed GSTR-2B import can be reconciled');
      }
      const activeGstinImport = await this.db.gstr2b_imports
        .where('[business_id+tax_period_key]')
        .equals([input.businessId, imported.tax_period_key])
        .filter((row) => row.gstin_snapshot === imported.gstin_snapshot && row.is_latest === 1)
        .first();
      if (!activeGstinImport || activeGstinImport.id !== imported.id) {
        throw new Error('Reconcile the latest import for this GSTIN and tax period');
      }

        const documents = await this.db.gstr2b_documents
          .where('[business_id+gstr2b_import_id]')
          .equals([input.businessId, input.importId])
          .toArray();
        const [, month] = imported.tax_period_key.split('-').map(Number);
        const periodStart = `${imported.tax_period_key}-01`;
        const nextPeriod = new Date(Date.UTC(Number(imported.tax_period_key.slice(0, 4)), month, 1));
        const periodEnd = new Date(nextPeriod.getTime() - 86_400_000).toISOString().slice(0, 10);
        const portalDates = documents
          .filter((document) => document.document_type?.toUpperCase() !== 'IMPORT_OF_SERVICES')
          .flatMap((document) => [document.document_date, document.original_document_date])
          .filter((date): date is string => !!date && /^\d{4}-\d{2}-\d{2}$/.test(date));
        const [periodPurchases, suppliers, priorMatches] = await Promise.all([
          this.db.purchases
            .where('[business_id+bill_date]')
            .between([input.businessId, periodStart], [input.businessId, periodEnd], true, true)
            .toArray(),
          this.db.suppliers.where('business_id').equals(input.businessId).toArray(),
          this.db.gst_matches
            .where('gstr2b_import_id')
            .equals(input.importId)
            .filter((row) => row.business_id === input.businessId)
            .toArray(),
        ]);
        const portalGstins = new Set(documents
          .filter((document) => document.document_type?.toUpperCase() !== 'IMPORT_OF_SERVICES')
          .map((document) => document.supplier_gstin)
          .filter((gstin): gstin is string => !!gstin));
        const portalYears = new Set(portalDates.map((date) => date.slice(0, 4)));
        const relatedSupplierIds = suppliers.filter((supplier) => portalGstins.has(supplier.gstin ?? '')).map((supplier) => supplier.id);
        const relatedSupplierPurchases = (await Promise.all(relatedSupplierIds.map((supplierId) =>
          this.db.purchases.where('[business_id+supplier_id]').equals([input.businessId, supplierId]).toArray(),
        ))).flat().filter((purchase) => portalYears.has(purchase.bill_date.slice(0, 4)));
        const suppliersById = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
        const purchasesById = new Map<string, { purchase: Purchase; includeBooksOnly: boolean }>();
        for (const purchase of [...periodPurchases, ...relatedSupplierPurchases]) {
          const inPeriod = purchase.bill_date >= periodStart && purchase.bill_date <= periodEnd;
          const existing = purchasesById.get(purchase.id);
          purchasesById.set(purchase.id, {
            purchase,
            includeBooksOnly: inPeriod || (existing?.includeBooksOnly ?? false),
          });
        }
        const purchaseRegister = [...purchasesById.values()].map(({ purchase, includeBooksOnly }) => {
          const supplier = suppliersById.get(purchase.supplier_id);
          return { purchase, supplier: supplier ?? null, includeBooksOnly };
        });
        const proposals = reconcileGstr2bDocuments(input.businessId, documents, purchaseRegister, input);
        const documentById = new Map(documents.map((document) => [document.id, document]));
        matches = proposals.map((proposal) => {
          const document = proposal.gstr2bDocumentId ? documentById.get(proposal.gstr2bDocumentId) : undefined;
          let status = proposal.status;
          if (document?.ims_status === 'REJECTED') status = 'IMS_REJECTED';
          else if (document?.ims_status === 'PENDING') status = 'IMS_PENDING';
          else if (document?.itc_availability?.toUpperCase() === 'NO') status = 'ITC_NOT_AVAILABLE';
          else if (document?.reverse_charge === 1 || document?.document_type?.toUpperCase() === 'IMPORT_OF_SERVICES') status = 'RCM_REVIEW_REQUIRED';
          return {
          id: ulid(),
          business_id: input.businessId,
          gstr2b_import_id: input.importId,
          gstr2b_document_id: proposal.gstr2bDocumentId,
          book_source_type: proposal.bookSourceType ?? null,
          book_source_id: proposal.bookSourceId,
          status,
          confidence_bps: proposal.confidenceBps,
          taxable_difference_paise: proposal.taxableDifferencePaise,
          igst_difference_paise: proposal.igstDifferencePaise,
          cgst_difference_paise: proposal.cgstDifferencePaise,
          sgst_difference_paise: proposal.sgstDifferencePaise,
          cess_difference_paise: proposal.cessDifferencePaise,
          confirmed_at: null,
          confirmed_by_device_id: null,
          confirmation_note: null,
          created_at: now,
          updated_at: now,
          entity_version: 1,
          };
        });
        const audit = {
          id: ulid(),
          business_id: input.businessId,
          device_id: input.deviceId,
          actor: `device:${input.deviceId}`,
          action: 'gstr2b.reconciled',
          entity_type: 'gstr2b_import',
          entity_id: input.importId,
          before: { matches: priorMatches },
          after: {
            match_count: matches.length,
            status_counts: matches.reduce<Record<string, number>>((counts, row) => {
              counts[row.status] = (counts[row.status] ?? 0) + 1;
              return counts;
            }, {}),
          },
          at: now,
        };

        await this.db.gst_matches.bulkDelete(priorMatches.map((row) => row.id));
        await this.db.gst_matches.bulkAdd(matches);
        await this.db.audit_log.add(audit);
        await appendSyncEvent(this.db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'gst_match_run',
          entityId: input.importId,
          operation: 'created',
          timestamp: now,
          payload: {
            business_id: input.businessId,
            gstr2b_import_id: input.importId,
            replace_match_ids: priorMatches.map((row) => row.id),
            matches,
            audit,
          },
        });
      },
    );

    pokeSyncWorker();
    return matches;
  }
}
