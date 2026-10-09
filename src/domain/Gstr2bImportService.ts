import { ulid } from 'ulid';
import type { BusinessVaultDB } from '../db/database';
import type { Gstr2bDocument, Gstr2bImport } from '../db/types';
import { appendSyncEvent } from './syncEventLog';
import { isValidGstin } from '../lib/gst';
import { pokeSyncWorker } from '../sync/pokeChannel';
import { officialGstr2bAdapters, parseGstr2bFile, type Gstr2bAdapter } from './Gstr2bAdapters';

export type Gstr2bDocumentInput = Omit<
  Gstr2bDocument,
  'id' | 'business_id' | 'gstr2b_import_id' | 'created_at' | 'updated_at' | 'entity_version'
>;

export interface ImportGstr2bInput {
  businessId: string;
  deviceId: string;
  gstin: string;
  taxPeriodKey: string;
  sourceType: Gstr2bImport['source_type'];
  fileName: string;
  file: Blob;
  schemaAdapterVersion: string;
  documents: Gstr2bDocumentInput[];
  portalGeneratedAt?: string | null;
  recomputedAt?: string | null;
  parseErrors?: unknown[];
}

export interface Gstr2bImportResult {
  imported: Gstr2bImport;
  documents: Gstr2bDocument[];
}

async function sha256Hex(blob: Blob): Promise<string> {
  const bytes = await new Response(blob).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateDocument(document: Gstr2bDocumentInput, index: number): void {
  for (const [key, value] of Object.entries(document)) {
    if (key.endsWith('_paise') && value !== null && !Number.isSafeInteger(value)) {
      throw new Error(`GSTR-2B document ${index + 1} has invalid ${key}; amounts must be safe integer paise`);
    }
  }
}

export class Gstr2bImportService {
  constructor(private readonly db: BusinessVaultDB) {}

  async importFile(
    input: Omit<ImportGstr2bInput, 'schemaAdapterVersion' | 'documents' | 'parseErrors'>,
    adapters: readonly Gstr2bAdapter[] = officialGstr2bAdapters,
  ): Promise<Gstr2bImportResult> {
    const parsed = await parseGstr2bFile({
      sourceType: input.sourceType,
      fileName: input.fileName,
      mimeType: input.file.type,
      file: input.file,
    }, adapters);
    const parseErrors = [...parsed.result.parseErrors];
    if (parsed.result.gstin !== input.gstin) {
      parseErrors.push({
        code: parsed.result.gstin ? 'GSTIN_MISMATCH' : 'GSTIN_MISSING',
        message: parsed.result.gstin
          ? 'The GSTIN in the imported file does not match the selected GST profile.'
          : 'The imported file does not contain a GSTIN.',
        path: 'gstin',
      });
    }
    if (parsed.result.taxPeriodKey !== input.taxPeriodKey) {
      parseErrors.push({
        code: parsed.result.taxPeriodKey ? 'PERIOD_MISMATCH' : 'PERIOD_MISSING',
        message: parsed.result.taxPeriodKey
          ? 'The tax period in the imported file does not match the selected period.'
          : 'The imported file does not contain a tax period.',
        path: 'taxPeriodKey',
      });
    }
    return this.persistImport({
      ...input,
      schemaAdapterVersion: parsed.adapterVersion,
      documents: parseErrors.length > 0 ? [] : parsed.result.documents,
      parseErrors,
      portalGeneratedAt: parsed.result.portalGeneratedAt,
      recomputedAt: parsed.result.recomputedAt,
    });
  }

  private async persistImport(input: ImportGstr2bInput): Promise<Gstr2bImportResult> {
    if (!input.businessId || !input.deviceId) throw new Error('businessId and deviceId are required');
    if (!isValidGstin(input.gstin)) throw new Error('A valid GSTIN is required for GSTR-2B import');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.taxPeriodKey)) {
      throw new Error('taxPeriodKey must be YYYY-MM');
    }
    if (!input.fileName.trim()) throw new Error('fileName is required');
    if (!input.schemaAdapterVersion.trim()) throw new Error('schemaAdapterVersion is required');
    if (input.parseErrors?.length && input.documents.length > 0) {
      throw new Error('A failed GSTR-2B parse cannot include normalized documents');
    }
    input.documents.forEach(validateDocument);

    const hash = await sha256Hex(input.file);
    const now = new Date().toISOString();
    const id = ulid();
    const attachmentId = ulid();
    const safeFileName = input.fileName.replace(/[\\/]/g, '_');
    const attachmentPath = `attachments/gstr2b/${id}-${safeFileName}`;
    let imported!: Gstr2bImport;
    let documents!: Gstr2bDocument[];

    await this.db.transaction(
      'rw',
      [this.db.gst_profiles, this.db.gstr2b_imports, this.db.gstr2b_documents, this.db.attachments, this.db.audit_log, this.db.sync_events, this.db.sync_queue],
      async () => {
        const duplicate = await this.db.gstr2b_imports
          .where('[business_id+sha256]')
          .equals([input.businessId, hash])
          .first();
        if (duplicate) throw new Error(`This GSTR-2B file was already imported as ${duplicate.id}`);

        const profile = await this.db.gst_profiles
          .where('[business_id+gstin]')
          .equals([input.businessId, input.gstin])
          .filter((row) => row.active === 1)
          .first();
        if (!profile) throw new Error('Add an active GST profile for this GSTIN before importing GSTR-2B');

        const priorVersions = await this.db.gstr2b_imports
          .where('[business_id+tax_period_key]')
          .equals([input.businessId, input.taxPeriodKey])
          .toArray();
        const previousLatest = input.parseErrors?.length
          ? undefined
          : priorVersions.find((row) => row.gstin_snapshot === input.gstin && row.is_latest === 1);
        imported = {
          id,
          business_id: input.businessId,
          gstin_snapshot: input.gstin,
          tax_period_key: input.taxPeriodKey,
          source_type: input.sourceType,
          original_attachment_id: attachmentId,
          sha256: hash,
          imported_at: now,
          portal_generated_at: input.portalGeneratedAt ?? null,
          recomputed_at: input.recomputedAt ?? null,
          schema_adapter_version: input.schemaAdapterVersion,
          parse_status: input.parseErrors?.length ? 'FAILED' : 'PARSED',
          parse_errors_json: input.parseErrors?.length ? JSON.stringify(input.parseErrors) : null,
          supersedes_import_id: previousLatest?.id ?? null,
          is_latest: input.parseErrors?.length ? 0 : 1,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        };
        documents = input.documents.map((document) => ({
          ...document,
          id: ulid(),
          business_id: input.businessId,
          gstr2b_import_id: id,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        } satisfies Gstr2bDocument));
        const attachment = {
          id: attachmentId,
          business_id: input.businessId,
          ref_type: 'gstr2b_import' as const,
          ref_id: id,
          filename: input.fileName,
          mime_type: input.file.type || 'application/octet-stream',
          size_bytes: input.file.size,
          checksum: hash,
          blob: input.file,
          drive_file_id: null,
          logical_path: attachmentPath,
          created_at: now,
          updated_at: now,
        };
        const supersededImports = previousLatest
          ? [{ ...previousLatest, is_latest: 0 as const, updated_at: now, entity_version: previousLatest.entity_version + 1 }]
          : [];
        const audit = {
          id: ulid(),
          business_id: input.businessId,
          device_id: input.deviceId,
          actor: `device:${input.deviceId}`,
          action: input.parseErrors?.length ? 'gstr2b.import_parse_failed' : 'gstr2b.imported',
          entity_type: 'gstr2b_import',
          entity_id: id,
          before: previousLatest ? { latest_import_id: previousLatest.id } : null,
          after: { sha256: hash, tax_period_key: input.taxPeriodKey, source_type: input.sourceType },
          at: now,
        };
        const uploadJob = {
          id: ulid(),
          business_id: input.businessId,
          kind: 'attachment_upload' as const,
          payload: { attachmentId },
          status: 'pending' as const,
          attempts: 0,
          max_attempts: 12,
          next_attempt_at: now,
          last_error: null,
          created_at: now,
          updated_at: now,
        };
        for (const old of supersededImports) await this.db.gstr2b_imports.put(old);
        await this.db.gstr2b_imports.add(imported);
        await this.db.gstr2b_documents.bulkAdd(documents);
        await this.db.attachments.add(attachment);
        await this.db.audit_log.add(audit);
        await this.db.sync_queue.add(uploadJob);
        await appendSyncEvent(this.db, {
          businessId: input.businessId,
          deviceId: input.deviceId,
          entityType: 'gstr2b_import',
          entityId: id,
          operation: 'created',
          timestamp: now,
          idempotencyKey: `gstr2b-import:${input.businessId}:${hash}`,
          payload: {
            business_id: input.businessId,
            import: imported,
            documents,
            attachment: { ...attachment, blob: null },
            superseded_imports: supersededImports,
            audit,
          },
        });
      },
    );

    pokeSyncWorker();
    return { imported, documents };
  }
}
