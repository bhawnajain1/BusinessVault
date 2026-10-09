import { expect, it } from 'vitest';
import { buildDocumentSeries } from './documentSeries';
import type { NormalizedGstDocument } from './types';

it('sorts numeric sequences, preserves leading zeros, separates types/prefixes and detects gaps/duplicates', () => {
  const doc = (id: string, number: string, type = 'TAX_INVOICE', cancelled = false) => ({ source_entity_id: id, document_number: number, document_type: type, included: !cancelled, cancelled } as NormalizedGstDocument);
  const rows = buildDocumentSeries([doc('3', 'INV/000003'), doc('1', 'INV/000001'), doc('copy', 'INV/000003'), doc('4', 'INV/000004', 'TAX_INVOICE', true), doc('cn', 'CN-000001', 'CREDIT_NOTE'), doc('other', 'OTHER-000001')]);
  const inv = rows.find(r => r.series === 'INV/')!;
  expect(inv).toMatchObject({ serial_from: 'INV/000001', serial_to: 'INV/000004', total_issued: 4, cancelled: 1, net_issued: 3, duplicates: ['INV/000003'], status: 'ERROR' });
  expect(inv.gaps).toEqual([{ from: 'INV/000002', to: 'INV/000002' }]); expect(rows).toHaveLength(3);
});

it('stores large sequence gaps as ranges rather than enumerating them', () => {
  const rows = buildDocumentSeries(['INV-00000000000000000001', 'INV-99999999999999999999'].map((number, i) => ({ source_entity_id: String(i), document_number: number, document_type: 'TAX_INVOICE', included: true, cancelled: false } as NormalizedGstDocument)));
  expect(rows[0].gaps).toEqual([{ from: 'INV-00000000000000000002', to: 'INV-99999999999999999998' }]);
});

it('keeps sequence-width changes in the same prefix series', () => {
  const rows = buildDocumentSeries(['INV9', 'INV10', 'INV12'].map((number, i) => ({ source_entity_id: String(i), document_number: number, document_type: 'TAX_INVOICE', included: true, cancelled: false } as NormalizedGstDocument)));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ serial_from: 'INV9', serial_to: 'INV12', total_issued: 3, gaps: [{ from: 'INV11', to: 'INV11' }] });
});
