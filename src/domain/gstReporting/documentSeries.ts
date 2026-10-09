import type { GstDocumentSeriesRow, NormalizedGstDocument } from './types';

export function buildDocumentSeries(documents: NormalizedGstDocument[]): GstDocumentSeriesRow[] {
  const groups = new Map<string, Array<{ document: NormalizedGstDocument; prefix: string; digits: string | null }>>();
  for (const document of documents) {
    if (!document.included && !document.cancelled && document.exclusion_reason !== 'DUPLICATE') continue;
    const match = /^(.*?)(\d+)$/.exec(document.document_number);
    const prefix = match?.[1] ?? document.document_number;
    const key = JSON.stringify([document.document_type, prefix]);
    const group = groups.get(key) ?? [];
    group.push({ document, prefix, digits: match?.[2] ?? null });
    groups.set(key, group);
  }
  const result: GstDocumentSeriesRow[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => {
      if (a.digits && b.digits) {
        const left = BigInt(a.digits), right = BigInt(b.digits);
        if (left !== right) return left < right ? -1 : 1;
      }
      return a.document.document_number.localeCompare(b.document.document_number)
        || a.document.source_entity_id.localeCompare(b.document.source_entity_id);
    });
    const seen = new Set<string>(), duplicates = new Set<string>();
    const gaps: GstDocumentSeriesRow['gaps'] = [];
    let previous: bigint | null = null;
    for (const entry of group) {
      const number = entry.document.document_number;
      if (seen.has(number)) duplicates.add(number);
      seen.add(number);
      if (entry.digits) {
        const sequence = BigInt(entry.digits);
        if (previous !== null && sequence > previous + 1n) {
          const format = (n: bigint) => entry.prefix + String(n).padStart(entry.digits!.length, '0');
          gaps.push({ from: format(previous + 1n), to: format(sequence - 1n) });
        }
        previous = sequence;
      }
    }
    const cancelled = group.filter(entry => entry.document.cancelled).length;
    result.push({ document_nature: group[0].document.document_type, series: group[0].prefix,
      serial_from: group[0].document.document_number, serial_to: group[group.length - 1].document.document_number,
      total_issued: group.length, cancelled, net_issued: group.length - cancelled,
      gaps, duplicates: [...duplicates].sort(), source_entity_ids: group.map(entry => entry.document.source_entity_id),
      status: duplicates.size ? 'ERROR' : gaps.length || group.some(entry => !entry.digits) ? 'WARNING' : 'PASS' });
  }
  return result.sort((a, b) => a.document_nature.localeCompare(b.document_nature) || a.series.localeCompare(b.series) || a.serial_from.localeCompare(b.serial_from));
}
