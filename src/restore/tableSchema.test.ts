import { describe, expect, it } from 'vitest';
import { coerceRow, findTableSpecByFile, TABLE_SPECS } from './tableSchema';

const gstStores = [
  'gst_profiles',
  'gst_aato',
  'gst_document_metadata',
  'gst_report_runs',
  'gst_report_rows',
  'gst_adjustments',
  'gstr2b_imports',
  'gstr2b_documents',
  'gst_matches',
  'gst_itc_ledger',
];

describe('GST snapshot table schema', () => {
  it('includes the requirements-critical fields in durable GST CSV tables', () => {
    const columns = (file: string) =>
      findTableSpecByFile(file)!.columns.map(({ name }) => name);

    expect(columns('gst_profiles.csv')).toEqual(expect.arrayContaining([
      'gst_reporting_enabled', 'registration_start_date', 'registration_end_date',
      'filing_frequency', 'effective_from', 'effective_to', 'gstin', 'state_code',
      'created_at', 'updated_at', 'entity_version',
    ]));
    expect(columns('gst_aato.csv')).toEqual(expect.arrayContaining([
      'aato_paise', 'source', 'confirmed_at', 'notes', 'financial_year',
    ]));
    expect(columns('gst_report_runs.csv')).toEqual(expect.arrayContaining([
      'gstin_snapshot', 'report_type', 'financial_year', 'tax_period_key',
      'period_start', 'period_end', 'filing_frequency', 'rule_set_version', 'status',
      'generated_at', 'generated_by_device_id', 'source_data_hash',
      'source_artifact_attachment_id', 'imported_file_hash', 'totals_json',
      'finalized_at', 'filed_at', 'arn', 'filing_acknowledgment_attachment_id',
      'supersedes_report_run_id',
    ]));
    expect(columns('gst_report_rows.csv')).toEqual(expect.arrayContaining([
      'report_run_id', 'section_code', 'row_key', 'source_entity_type',
      'source_entity_id', 'source_entity_version', 'classification_reason',
      'taxable_paise', 'igst_paise', 'cgst_paise', 'sgst_paise', 'cess_paise',
      'invoice_value_paise', 'quantity_micros', 'payload_json',
    ]));
    expect(columns('gst_document_metadata.csv')).toEqual(expect.arrayContaining([
      'source_entity_type', 'source_entity_id', 'document_type', 'supply_category',
      'recipient_category', 'place_of_supply_state_code', 'reverse_charge',
      'ecommerce_operator_gstin', 'ecommerce_reporting_type', 'section_9_5_role',
      'section_52_tcs', 'shipping_bill_number', 'shipping_bill_date', 'port_code',
      'original_document_number', 'original_document_date', 'original_return_period',
      'amendment_kind', 'tax_on_advance_applicable', 'classification_source',
    ]));
    expect(columns('gstr2b_imports.csv')).toEqual(expect.arrayContaining([
      'gstin_snapshot', 'tax_period_key', 'source_type', 'original_attachment_id',
      'sha256', 'imported_at', 'portal_generated_at', 'recomputed_at',
      'schema_adapter_version', 'parse_status', 'parse_errors_json',
      'supersedes_import_id', 'is_latest',
    ]));
    expect(columns('gstr2b_documents.csv')).toEqual(expect.arrayContaining([
      'source_section', 'supplier_name', 'supplier_gstin', 'document_type',
      'canonical_document_number', 'search_normalized_document_number', 'document_date',
      'original_document_number', 'original_document_date', 'filing_period',
      'place_of_supply_state_code', 'reverse_charge', 'taxable_paise', 'igst_paise',
      'cgst_paise', 'sgst_paise', 'cess_paise', 'invoice_value_paise',
      'itc_availability', 'itc_unavailable_reason', 'ims_status',
      'declared_itc_reduction_paise', 'ims_remark', 'bill_of_entry_number',
      'bill_of_entry_date', 'port_code', 'raw_payload_json',
    ]));
    expect(columns('gst_matches.csv')).toEqual(expect.arrayContaining([
      'gstr2b_import_id', 'gstr2b_document_id', 'book_source_type', 'book_source_id',
      'status', 'taxable_difference_paise', 'igst_difference_paise',
      'cgst_difference_paise', 'sgst_difference_paise', 'cess_difference_paise',
      'confirmed_at', 'confirmed_by_device_id', 'confirmation_note',
    ]));
    expect(columns('gst_itc_ledger.csv')).toEqual(expect.arrayContaining([
      'source_entity_type', 'source_entity_id', 'tax_period_key', 'category',
      'tax_head', 'original_eligible_paise', 'temporarily_reversed_paise',
      'permanently_reversed_paise', 'reclaimable_paise', 'reclaimed_paise',
      'status', 'reason_code', 'related_prior_entry_id', 'user_confirmation',
    ]));
    expect(columns('gst_adjustments.csv')).toEqual(expect.arrayContaining([
      'report_run_id', 'table_code', 'tax_head', 'original_paise', 'adjusted_paise',
      'reason', 'supporting_attachment_id', 'source', 'actor_id', 'device_id',
      'created_at',
    ]));

    expect(columns('gstr2b_documents.csv')).not.toContain('normalized_document_number');
    expect(columns('gstr2b_imports.csv')).not.toContain('source_checksum');
  });

  it('uses paise coercion for every monetary column in every new GST CSV table', () => {
    const specs = TABLE_SPECS.filter(({ store }) => gstStores.includes(store));
    expect(specs).toHaveLength(gstStores.length);

    for (const spec of specs) {
      for (const column of spec.columns.filter(({ name }) => name.endsWith('_paise'))) {
        expect(column.type, `${spec.file}:${column.name}`).toBe('paise');
      }
    }
  });

  it('rejects non-integer and unsafe paise values with explicit errors', () => {
    const spec = {
      file: 'gst_amounts.csv',
      store: 'gst_amounts',
      pk: 'id',
      columns: [{ name: 'amount_paise', type: 'paise' as const }],
    };

    expect(() => coerceRow({ amount_paise: '12.5' }, spec)).toThrow(/amount_paise.*integer paise/i);
    expect(() => coerceRow({ amount_paise: '9007199254740992' }, spec)).toThrow(/amount_paise.*safe integer/i);
    expect(coerceRow({ amount_paise: '12' }, spec)).toEqual({ amount_paise: 12 });
    expect(coerceRow({ amount_paise: '' }, spec)).toEqual({ amount_paise: null });
  });
});
