import { describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import {
  Gstr2bAdapterUnavailableError,
  officialGstr2bAdapters,
  parseGstr2bFile,
  type Gstr2bAdapter,
} from './Gstr2bAdapters';

describe('GSTR-2B adapter boundary', () => {
  it('does not claim portal parsing support without a verified adapter', async () => {
    expect(officialGstr2bAdapters).toEqual([]);
    await expect(parseGstr2bFile({
      sourceType: 'GSTR2B_JSON',
      fileName: 'portal-download.json',
      mimeType: 'application/json',
      file: new NodeBlob(['{}']),
    })).rejects.toBeInstanceOf(Gstr2bAdapterUnavailableError);
  });

  it('loads fixture bytes and dispatches to exactly one versioned adapter', async () => {
    const fixture = new TextEncoder().encode('redacted-fixture-bytes');
    const parse = vi.fn(async ({ bytes }: { bytes: Uint8Array }) => ({
      gstin: '27AAAAA0000A1Z0',
      taxPeriodKey: '2026-08',
      documents: [],
      parseErrors: [],
      portalGeneratedAt: null,
      recomputedAt: null,
      rawBytesSeen: bytes.length,
    }));
    const adapter: Gstr2bAdapter = {
      sourceType: 'GSTR2B_JSON',
      version: 'fixture-adapter-test-v1',
      detect: ({ bytes }) => new TextDecoder().decode(bytes).startsWith('redacted-fixture-'),
      parse: async (input) => parse(input),
    };

    const { adapterVersion, result } = await parseGstr2bFile({
      sourceType: 'GSTR2B_JSON',
      fileName: 'redacted-fixture.json',
      mimeType: 'application/json',
      file: new NodeBlob([fixture]),
    }, [adapter]);

    expect(adapterVersion).toBe('fixture-adapter-test-v1');
    expect(parse).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ gstin: '27AAAAA0000A1Z0', taxPeriodKey: '2026-08', rawBytesSeen: fixture.length });
  });

  it('rejects ambiguous adapters rather than selecting by registration order', async () => {
    const adapter: Gstr2bAdapter = {
      sourceType: 'GSTR2B_JSON',
      version: 'fixture-adapter-test-v1',
      detect: () => true,
      parse: async () => ({ gstin: null, taxPeriodKey: null, documents: [], parseErrors: [] }),
    };
    const input = {
      sourceType: 'GSTR2B_JSON' as const,
      fileName: 'portal-download.json',
      mimeType: 'application/json',
      file: new NodeBlob(['{}']),
    };

    await expect(parseGstr2bFile(input, [adapter, { ...adapter, version: 'fixture-adapter-test-v2' }]))
      .rejects.toThrow('Multiple GSTR2B_JSON adapters recognize');
  });
});
