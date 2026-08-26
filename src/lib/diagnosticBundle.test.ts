import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ulid } from 'ulid';
import { buildDiagnosticReport } from './diagnosticBundle';
import { db } from '../db';
import { log } from './log';
import type { Business, AuditLogEntry } from '../db/types';

function makeBusiness(overrides: Partial<Business> = {}): Business {
  const now = new Date().toISOString();
  return {
    id: 'biz1',
    name: 'Acme Traders',
    legal_name: 'Acme Traders',
    gstin: '29AABCS1234A1Z5',
    pan: 'AABCS1234A',
    address_line1: '1 MG Rd',
    address_line2: '',
    city: 'Bengaluru',
    state: 'Karnataka',
    state_code: '29',
    pincode: '560001',
    country: 'IN',
    phone: '',
    email: '',
    financial_year_start_month: 4,
    current_financial_year: '2026-27',
    currency: 'INR',
    logo_ref: null,
    signature_ref: null,
    show_signature_on_invoice: 0,
    invoice_prefix: 'INV',
    invoice_next_seq: 1,
    drive_folder_id: null,
    drive_connected_email: null,
    schema_version: 3,
    created_at: now,
    updated_at: now,
    entity_version: 1,
    ...overrides,
  } as Business;
}

describe('§16 buildDiagnosticReport', () => {
  beforeEach(async () => {
    await db.businesses.clear();
    await db.debug_logs.clear();
    await db.audit_log.clear();
    await db.invoices.clear();
    await db.journal_entries.clear();
    await db.journal_lines.clear();
  });

  it('returns a null business + empty audit block when no business exists', async () => {
    const r = await buildDiagnosticReport();
    expect(r.business).toBeNull();
    expect(r.audit_log_recent).toEqual([]);
    expect(r.reconciliation).toBeNull();
    expect(r.app.version).toBeTypeOf('string');
    expect(r.schema.dexie_verno).toBeGreaterThan(0);
  });

  it('populates business + reconciliation when a business is present', async () => {
    const b = makeBusiness();
    await db.businesses.put(b);
    const r = await buildDiagnosticReport();
    expect(r.business).not.toBeNull();
    expect(r.business!.id).toBe('biz1');
    expect(r.business!.name).toBe('Acme Traders');
    expect(r.business!.drive_connected).toBe(false);
    expect(r.schema.business_schema_version).toBe(3);
    expect(r.reconciliation).not.toBeNull();
    expect(r.reconciliation!.trial_balance_balanced).toBe(true); // no entries yet
  });

  it('surfaces drive_connected_email when Drive is linked', async () => {
    await db.businesses.put(
      makeBusiness({ drive_folder_id: 'folder123', drive_connected_email: 'owner@x.com' }),
    );
    const r = await buildDiagnosticReport();
    expect(r.business!.drive_connected).toBe(true);
    expect(r.business!.drive_connected_email).toBe('owner@x.com');
  });

  it('includes the last N audit log rows in reverse-chronological order', async () => {
    await db.businesses.put(makeBusiness());
    const now = Date.now();
    const rows: AuditLogEntry[] = Array.from({ length: 3 }, (_, i) => ({
      id: ulid(),
      business_id: 'biz1',
      device_id: 'dev1',
      actor: 'user',
      action: `test.action.${i}`,
      entity_type: 'invoice',
      entity_id: `inv${i}`,
      before: null,
      after: null,
      at: new Date(now + i * 1000).toISOString(),
    }));
    await db.audit_log.bulkAdd(rows);
    const r = await buildDiagnosticReport({ auditLogLimit: 10 });
    expect(r.audit_log_recent).toHaveLength(3);
    // Most recent first.
    expect(r.audit_log_recent[0].action).toBe('test.action.2');
    expect(r.audit_log_recent[2].action).toBe('test.action.0');
  });

  it('splits recent debug logs into backup / restore buckets', async () => {
    log.info('drive.backup', 'started', { operationId: 'op1' });
    log.info('drive.restore', 'started', { operationId: 'op2' });
    log.info('other', 'unrelated', {});
    await log.flush();
    const r = await buildDiagnosticReport({ logWindowMs: 24 * 60 * 60 * 1000 });
    expect(r.drive.recent_backup_events.some((e) => e.source === 'drive.backup')).toBe(true);
    expect(r.drive.recent_restore_events.some((e) => e.source === 'drive.restore')).toBe(true);
    expect(r.debug_log.length).toBeGreaterThanOrEqual(3);
  });

  it('never leaks sensitive keys — redaction pass runs before persistence', async () => {
    // log.ts SENSITIVE_KEY_RE covers /token|password|secret|auth|api[_-]?key/i.
    log.info('drive.oauth', 'exchange', {
      access_token: 'ya29.SECRETVALUE',
      refresh_token: 'REFRESHVALUE',
    });
    await log.flush();
    const r = await buildDiagnosticReport();
    const json = JSON.stringify(r);
    expect(json).not.toContain('SECRETVALUE');
    expect(json).not.toContain('REFRESHVALUE');
    expect(json).toContain('<redacted>');
  });
});
