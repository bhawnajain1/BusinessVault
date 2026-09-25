import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { startSnapshotScheduler } from './snapshotScheduler';

const business = (id: string) => ({
  id,
  name: id,
  legal_name: id,
  gstin: null,
  pan: null,
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  state_code: '',
  pincode: '',
  country: 'India',
  phone: '',
  email: '',
  financial_year_start_month: 4,
  current_financial_year: '2026-27',
  currency: 'INR',
  logo_ref: null,
  invoice_prefix: 'INV-',
  invoice_next_seq: 1,
  default_invoice_terms: '',
  drive_folder_id: null,
  drive_connected_email: null,
  schema_version: 1,
  signature_ref: null,
  show_signature_on_invoice: 0 as const,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  entity_version: 1,
});

describe('snapshot scheduler safety', () => {
  afterEach(async () => {
    await db.kv.clear();
    await db.businesses.clear();
  });

  it('tracks snapshot cadence independently per business', async () => {
    await db.businesses.bulkPut([business('biz_a'), business('biz_b')]);
    const built: string[] = [];
    const scheduler = startSnapshotScheduler({
      clock: () => new Date('2026-08-27T10:00:00.000Z'),
      buildSnapshot: async (businessId, kind) => {
        built.push(`${businessId}:${kind}`);
        return {
          businessId,
          kind,
          asOf: '2026-08-27',
          files: [],
          manifest: { businessId },
        };
      },
    });

    await scheduler.fireNow();
    await scheduler.fireNow();
    scheduler.stop();

    expect(built).toEqual(['biz_a:daily', 'biz_b:daily']);
  });

  it('joins overlapping fireNow calls instead of duplicating snapshots', async () => {
    await db.businesses.put(business('biz_a'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const built: string[] = [];
    const scheduler = startSnapshotScheduler({
      clock: () => new Date('2026-08-27T10:00:00.000Z'),
      buildSnapshot: async (businessId, kind) => {
        built.push(`${businessId}:${kind}`);
        await gate;
        return {
          businessId,
          kind,
          asOf: '2026-08-27',
          files: [],
          manifest: { businessId },
        };
      },
    });

    const first = scheduler.fireNow();
    const second = scheduler.fireNow();
    release();
    await Promise.all([first, second]);
    scheduler.stop();

    expect(built).toEqual(['biz_a:daily']);
  });
});
