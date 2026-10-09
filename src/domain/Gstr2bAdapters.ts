import type { Gstr2bDocumentInput } from './Gstr2bImportService';
import type { Gstr2bImport } from '../db/types';

export type Gstr2bSourceType = Gstr2bImport['source_type'];

export interface Gstr2bAdapterIssue {
  code: string;
  message: string;
  path?: string;
}

export interface Gstr2bAdapterResult {
  gstin: string | null;
  taxPeriodKey: string | null;
  documents: Gstr2bDocumentInput[];
  parseErrors: Gstr2bAdapterIssue[];
  portalGeneratedAt?: string | null;
  recomputedAt?: string | null;
}

export interface Gstr2bAdapter {
  sourceType: Gstr2bSourceType;
  version: string;
  detect(input: { fileName: string; mimeType: string; bytes: Uint8Array }): boolean;
  parse(input: { fileName: string; mimeType: string; bytes: Uint8Array }): Promise<Gstr2bAdapterResult>;
}

// No portal schema is registered until its official, redacted fixture is checked in.
export const officialGstr2bAdapters: readonly Gstr2bAdapter[] = [];

export class Gstr2bAdapterUnavailableError extends Error {
  constructor(sourceType: Gstr2bSourceType, fileName: string) {
    super(`No verified ${sourceType} adapter recognizes '${fileName}'. Import the official redacted fixture before enabling this format.`);
    this.name = 'Gstr2bAdapterUnavailableError';
  }
}

export async function parseGstr2bFile(
  input: { sourceType: Gstr2bSourceType; fileName: string; mimeType: string; file: Blob },
  adapters: readonly Gstr2bAdapter[] = officialGstr2bAdapters,
): Promise<{ adapterVersion: string; result: Gstr2bAdapterResult }> {
  const bytes = new Uint8Array(await new Response(input.file).arrayBuffer());
  const detectionInput = { fileName: input.fileName, mimeType: input.mimeType, bytes };
  const matches = adapters.filter(
    (adapter) => adapter.sourceType === input.sourceType && adapter.detect(detectionInput),
  );
  if (matches.length !== 1) {
    if (matches.length > 1) {
      throw new Error(`Multiple ${input.sourceType} adapters recognize '${input.fileName}'`);
    }
    throw new Gstr2bAdapterUnavailableError(input.sourceType, input.fileName);
  }
  const adapter = matches[0];
  return {
    adapterVersion: adapter.version,
    result: await adapter.parse(detectionInput),
  };
}
