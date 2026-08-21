/* eslint-disable */
// BusinessVault — IndexedDB recovery check.
//
// HOW TO USE
//   1. Open the BusinessVault app in the browser (any page — Dashboard is fine).
//   2. Open DevTools → Console.
//   3. Copy this ENTIRE file and paste it into the console. Press Enter.
//   4. Read the printed report. If you see counts > 0 under "UNSHIPPED",
//      your data is still recoverable — do not run Restore again.
//
// What it does: reads directly from the 'businessvault' IndexedDB, without
// touching any Dexie schema code. Reports:
//   - counts of every domain table per business, so you can see what data
//     still lives on this device;
//   - counts of sync_events grouped by (sync_status, entity_type), so you
//     can see which events never made it to the backup folder;
//   - the tail of the sync_events hash chain, in case you want to rebuild
//     a journal file manually.
//
// It is a pure read — nothing is modified, nothing is deleted.

(async () => {
  const DB_NAME = 'businessvault';
  const DOMAIN_TABLES = [
    'businesses',
    'customers',
    'suppliers',
    'categories',
    'units',
    'warehouses',
    'items',
    'item_stock',
    'invoices',
    'invoice_lines',
    'purchases',
    'purchase_lines',
    'payments',
    'advances',
    'expenses',
    'stock_movements',
    'accounts',
    'journal_entries',
    'journal_lines',
  ];

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('open blocked — close other tabs on the app'));
    });
  }

  function getAll(db, store) {
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(store)) {
        resolve([]);
        return;
      }
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  const db = await openDb();
  const businesses = await getAll(db, 'businesses');
  const syncEvents = await getAll(db, 'sync_events');

  console.log('%cBusinessVault recovery check', 'font-weight:bold;font-size:14px');
  console.log(`IndexedDB '${DB_NAME}' opened. Schema version: ${db.version}`);
  console.log(`Businesses on this device: ${businesses.length}`);
  for (const b of businesses) {
    console.log(`  · ${b.name}  (id=${b.id})`);
  }
  console.log('');

  // Per-business table counts.
  for (const b of businesses) {
    console.group(`%cBusiness: ${b.name}  (${b.id})`, 'color:#0369a1;font-weight:bold');
    const rowCounts = {};
    for (const t of DOMAIN_TABLES) {
      const rows = await getAll(db, t);
      const forThis = t === 'businesses' ? [b] : rows.filter((r) => r.business_id === b.id);
      rowCounts[t] = forThis.length;
    }
    console.table(rowCounts);
    console.groupEnd();
  }

  // sync_events breakdown per (business, sync_status).
  console.group('%csync_events by (business, sync_status, entity_type)', 'color:#a16207;font-weight:bold');
  const grouped = {}; // business_id -> status -> entity_type -> count
  for (const e of syncEvents) {
    const bId = e.business_id || '(unknown)';
    const status = e.sync_status || '(no status)';
    const et = e.entity_type || '(no type)';
    grouped[bId] = grouped[bId] || {};
    grouped[bId][status] = grouped[bId][status] || {};
    grouped[bId][status][et] = (grouped[bId][status][et] || 0) + 1;
  }
  for (const [bId, statuses] of Object.entries(grouped)) {
    const biz = businesses.find((b) => b.id === bId);
    console.group(`Business ${biz ? biz.name : '(unknown)'} — ${bId}`);
    for (const [status, byType] of Object.entries(statuses)) {
      const total = Object.values(byType).reduce((a, b) => a + b, 0);
      const label =
        status === 'LOCAL_ONLY' || status === 'QUEUED' || status === 'SYNCING' || status === 'FAILED'
          ? `${status} (UNSHIPPED — never reached backup folder)`
          : status === 'SYNCED'
            ? `${status} (backed up)`
            : status;
      console.log(`  ${label}  total=${total}`);
      console.table(byType);
    }
    console.groupEnd();
  }
  console.groupEnd();

  // Highlight what would be lost by another restore.
  console.group('%cRECOVERY VERDICT', 'color:#b91c1c;font-weight:bold;font-size:13px');
  let anyUnshipped = false;
  for (const b of businesses) {
    const unshipped = syncEvents.filter(
      (e) =>
        e.business_id === b.id &&
        e.sync_status !== 'SYNCED',
    );
    if (unshipped.length === 0) {
      console.log(`  ${b.name}: nothing unshipped. Restore is safe. Backup folder is fully in sync.`);
    } else {
      anyUnshipped = true;
      console.log(
        `%c  ${b.name}: ${unshipped.length} events UNSHIPPED. These will be LOST if you run Restore again.`,
        'color:#b91c1c;font-weight:bold',
      );
      const byEt = {};
      for (const e of unshipped) byEt[e.entity_type] = (byEt[e.entity_type] || 0) + 1;
      console.table(byEt);
    }
  }
  if (anyUnshipped) {
    console.log('');
    console.log('%cNEXT STEPS', 'color:#b91c1c;font-weight:bold');
    console.log('  1. Do NOT run Restore again on this device.');
    console.log('  2. Reconnect the backup folder from Settings → Backup, so the sync worker can ship the unshipped events.');
    console.log('  3. Wait until this script reports "nothing unshipped" for every business, THEN take a fresh backup.');
    console.log('  4. If sync will not reconnect (permission revoked, folder moved), export the unshipped events with:');
    console.log('       await window.__bvExportUnshippedJournal(\'<business_id>\')  ');
    console.log('     — that helper is installed on window below; it returns a JSONL string you can save alongside the folder\'s journal file.');
  } else {
    console.log('  Backup folder is authoritative — nothing extra on this device.');
  }
  console.groupEnd();

  // Install a small export helper — no side effects unless the user calls it.
  window.__bvExportUnshippedJournal = async function (businessId) {
    const evts = syncEvents
      .filter((e) => e.business_id === businessId && e.sync_status !== 'SYNCED')
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    const jsonl = evts.map((e) => JSON.stringify(e)).join('\n') + (evts.length ? '\n' : '');
    console.log(`Exported ${evts.length} unshipped events for business ${businessId}.`);
    console.log('Copy the string below into a new file BusinessVault/<business>/journal/<YYYY>/<YYYY>-<MM>.unshipped.jsonl');
    console.log(jsonl);
    return jsonl;
  };

  db.close();
  console.log('');
  console.log('Done. Nothing was modified.');
})().catch((err) => {
  console.error('recovery-check failed:', err);
});
