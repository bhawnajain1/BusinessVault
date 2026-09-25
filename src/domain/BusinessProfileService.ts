import { ulid } from 'ulid';
import { db as defaultDb, type BusinessVaultDB } from '../db';
import type { Attachment, Business } from '../db/types';
import { log } from '../lib/log';

// §2 Authorised Signature — service for the Settings → Business Profile
// signature block.
//
// Signature assets live in the existing `attachments` table with
// `ref_type='signature'` and `ref_id=<business_id>`. Every upload creates a
// FRESH Attachment row (never overwrites an existing one) so that historical
// invoices — which snapshot the current `signature_ref` onto
// `invoice.signature_attachment_id` at creation time — can always resolve
// back to the exact image bytes that appeared on the printed invoice.
//
// Business.signature_ref points at the CURRENTLY-active signature; the
// invoice.signature_attachment_id is the immutable historical pointer. See
// InvoiceService.createInvoice for the snapshot side of this contract.

// Accept only the three formats listed in the spec. WebP is preferred for
// transparency + size but PNG/JPG are the pragmatic upload targets for
// shopkeepers scanning a paper signature. Reject SVG and PDF outright —
// SVG can carry script, PDF is not an image.
const ALLOWED_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

// 2 MB is generous for a signature scan — a 600×200 PNG runs ~30 KB. Anything
// larger is almost certainly a mis-sized upload (full-page camera shot) that
// would bloat every backup snapshot.
const MAX_BYTES = 2 * 1024 * 1024;
// Cap pixel dimensions so a huge canvas doesn't get shipped down to the
// print path — the invoice signature block is at most ~200 px tall. We
// cap at 2000 to leave headroom for hi-DPI users while still bounding the
// asset size (bytes are already capped separately).
const MAX_DIMENSION_PX = 2000;

export class SignatureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureValidationError';
  }
}

export interface SignatureUploadResult {
  attachment: Attachment;
  business: Business;
}

async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } })
    .crypto?.subtle;
  if (!subtle) throw new Error('SubtleCrypto unavailable');
  const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

async function decodeImageDimensions(
  blob: Blob,
): Promise<{ width: number; height: number }> {
  // createImageBitmap is on every modern browser + jsdom-with-Blob paths we
  // support. It rejects on non-image input, which is the fallback safety
  // net if MIME sniffing was spoofed.
  try {
    const bitmap = await createImageBitmap(blob);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dims;
  } catch (e) {
    log.warn('signature', 'image decode failed', { error: (e as Error).message });
    throw new SignatureValidationError(
      'Could not read this as an image. Upload PNG, JPG, or WebP.',
    );
  }
}

export class BusinessProfileService {
  private db: BusinessVaultDB;

  constructor(db: BusinessVaultDB = defaultDb) {
    this.db = db;
  }

  /**
   * Upload (or Replace) the business's Authorised Signature.
   *
   * Every call creates a FRESH Attachment row — never mutates an existing
   * one — so old invoices still resolve to the signature that was current
   * when they were issued (§2 historical preservation).
   *
   * Validates MIME (PNG/JPG/WebP), byte size (≤ 2 MB), and pixel dimensions
   * (≤ 2000 × 2000). Throws `SignatureValidationError` on any check failure
   * so the UI can surface a helpful message.
   */
  async uploadSignature(
    businessId: string,
    file: File,
  ): Promise<SignatureUploadResult> {
    log.info('signature', 'upload requested', {
      businessId,
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    });

    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      log.warn('signature', 'upload rejected: bad mime', {
        businessId,
        mimeType: file.type,
      });
      throw new SignatureValidationError(
        `Unsupported file type ${file.type || 'unknown'}. Please upload PNG, JPG, or WebP.`,
      );
    }
    if (file.size > MAX_BYTES) {
      log.warn('signature', 'upload rejected: too large', {
        businessId,
        sizeBytes: file.size,
        maxBytes: MAX_BYTES,
      });
      throw new SignatureValidationError(
        `Signature is too large (${(file.size / 1024 / 1024).toFixed(2)} MB). Maximum is ${MAX_BYTES / 1024 / 1024} MB.`,
      );
    }

    const dims = await decodeImageDimensions(file);
    if (dims.width > MAX_DIMENSION_PX || dims.height > MAX_DIMENSION_PX) {
      log.warn('signature', 'upload rejected: dimensions too large', {
        businessId,
        width: dims.width,
        height: dims.height,
        maxDimensionPx: MAX_DIMENSION_PX,
      });
      throw new SignatureValidationError(
        `Signature dimensions ${dims.width}×${dims.height} exceed ${MAX_DIMENSION_PX}×${MAX_DIMENSION_PX}. Please downscale before uploading.`,
      );
    }

    const business = await this.db.businesses.get(businessId);
    if (!business) throw new Error(`Business not found: ${businessId}`);

    // Copy the file blob into a stable Blob (File extends Blob so this is
    // effectively a shallow retype). Store a fresh checksum for the row so
    // integrity checks can compare bytes. `Response(file).arrayBuffer()` is
    // used instead of `file.arrayBuffer()` directly because jsdom's Blob
    // shim lacks the method — Response, however, is fully polyfilled by
    // undici/whatwg-fetch and works uniformly across browser + jsdom.
    const buffer = await new Response(file).arrayBuffer();
    const blob = new Blob([buffer], { type: file.type });
    const checksum = await sha256HexOfBytes(new Uint8Array(buffer));
    const now = new Date().toISOString();
    const attachmentId = ulid();

    const attachment: Attachment = {
      id: attachmentId,
      business_id: businessId,
      ref_type: 'signature',
      ref_id: businessId,
      // Filename is user-facing but not authoritative — the id is. Keep
      // the extension so Drive-side previews render correctly.
      filename: file.name || `signature-${attachmentId}`,
      mime_type: file.type,
      size_bytes: file.size,
      checksum,
      blob,
      drive_file_id: null,
      // Logical path drives the Drive upload target. `attachments/signatures/<id>`
      // keeps all generations side-by-side under one folder so the historical
      // preservation invariant survives a Drive restore.
      logical_path: `attachments/signatures/${attachmentId}`,
      created_at: now,
      updated_at: now,
    };

    const patchedBusiness: Business = {
      ...business,
      signature_ref: attachmentId,
      // Turning ON automatically on first upload so shopkeepers don't have
      // to click twice. Replace paths preserve whatever the toggle was.
      show_signature_on_invoice:
        business.signature_ref == null
          ? 1
          : business.show_signature_on_invoice ?? 1,
      updated_at: now,
      entity_version: (business.entity_version ?? 0) + 1,
    };

    await this.db.transaction(
      'rw',
      [this.db.attachments, this.db.businesses],
      async () => {
        await this.db.attachments.add(attachment);
        await this.db.businesses.put(patchedBusiness);
      },
    );

    log.info('signature', 'upload committed', {
      businessId,
      attachmentId,
      previousRef: business.signature_ref ?? null,
      showFlag: patchedBusiness.show_signature_on_invoice,
      checksum,
    });

    return { attachment, business: patchedBusiness };
  }

  /**
   * Remove the current signature reference from the business.
   *
   * The Attachment row(s) are LEFT IN PLACE — invoices that snapshotted an
   * earlier generation still need those bytes to render historically. Only
   * `business.signature_ref` and the toggle are cleared.
   */
  async removeSignature(businessId: string): Promise<Business> {
    log.info('signature', 'remove requested', { businessId });
    const business = await this.db.businesses.get(businessId);
    if (!business) throw new Error(`Business not found: ${businessId}`);
    if (business.signature_ref == null && !business.show_signature_on_invoice) {
      log.info('signature', 'remove no-op', { businessId });
      return business;
    }
    const now = new Date().toISOString();
    const patched: Business = {
      ...business,
      signature_ref: null,
      show_signature_on_invoice: 0,
      updated_at: now,
      entity_version: (business.entity_version ?? 0) + 1,
    };
    await this.db.businesses.put(patched);
    log.info('signature', 'remove committed', {
      businessId,
      previousRef: business.signature_ref ?? null,
    });
    return patched;
  }

  /**
   * Toggle whether newly-created invoices should snapshot the current
   * signature. Existing invoices are UNAFFECTED — they resolve their
   * signature via their own snapshot field (§2 historical preservation).
   */
  async setShowSignatureOnInvoice(
    businessId: string,
    enabled: boolean,
  ): Promise<Business> {
    log.info('signature', 'toggle requested', { businessId, enabled });
    const business = await this.db.businesses.get(businessId);
    if (!business) throw new Error(`Business not found: ${businessId}`);
    const next: 0 | 1 = enabled ? 1 : 0;
    if ((business.show_signature_on_invoice ?? 0) === next) {
      log.info('signature', 'toggle no-op', { businessId, enabled });
      return business;
    }
    const now = new Date().toISOString();
    const patched: Business = {
      ...business,
      show_signature_on_invoice: next,
      updated_at: now,
      entity_version: (business.entity_version ?? 0) + 1,
    };
    await this.db.businesses.put(patched);
    log.info('signature', 'toggle committed', { businessId, enabled });
    return patched;
  }
}

/**
 * Read the Attachment blob for a signature ref. Returns null if the id is
 * null, the row is missing, or its blob is null (Drive-only, not yet
 * hydrated). Used by the invoice print surface to render an <img> tag.
 */
export async function loadSignatureBlob(
  attachmentId: string | null | undefined,
  db: BusinessVaultDB = defaultDb,
): Promise<Blob | null> {
  if (!attachmentId) return null;
  const att = await db.attachments.get(attachmentId);
  if (!att || !att.blob) {
    log.warn('signature', 'signature blob missing', {
      attachmentId,
      hasRow: !!att,
    });
    return null;
  }
  return att.blob;
}
