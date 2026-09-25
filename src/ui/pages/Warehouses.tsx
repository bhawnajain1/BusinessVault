import { useEffect, useState } from 'react';
import { ulid } from 'ulid';
import { db } from '../../db';
import type { Warehouse } from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';

export default function Warehouses() {
  const { businessId, loading } = useActiveBusiness();
  const [rows, setRows] = useState<Warehouse[]>([]);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!businessId) return;
    const ws = await db.warehouses.where('business_id').equals(businessId).sortBy('name');
    setRows(ws);
  }

  useEffect(() => {
    refresh();
  }, [businessId]);

  function clearForm() {
    setEditingId(null);
    setName('');
    setAddress('');
    setIsDefault(false);
    setError(null);
  }

  async function save() {
    if (!businessId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    setError(null);
    const now = new Date().toISOString();

    await db.transaction('rw', db.warehouses, async () => {
      if (isDefault) {
        const others = await db.warehouses.where('business_id').equals(businessId).toArray();
        for (const w of others) {
          if (w.is_default === 1 && w.id !== editingId) {
            await db.warehouses.put({ ...w, is_default: 0, updated_at: now });
          }
        }
      }
      if (editingId) {
        const existing = await db.warehouses.get(editingId);
        if (!existing) return;
        await db.warehouses.put({
          ...existing,
          name: trimmed,
          address: address.trim(),
          is_default: isDefault ? 1 : 0,
          updated_at: now,
          entity_version: (existing.entity_version ?? 0) + 1,
        });
      } else {
        await db.warehouses.add({
          id: ulid(),
          business_id: businessId,
          name: trimmed,
          address: address.trim(),
          is_default: isDefault ? 1 : 0,
          active: 1,
          created_at: now,
          updated_at: now,
          entity_version: 1,
        });
      }
    });
    clearForm();
    refresh();
  }

  function startEdit(w: Warehouse) {
    setEditingId(w.id);
    setName(w.name);
    setAddress(w.address);
    setIsDefault(w.is_default === 1);
  }

  async function toggleActive(w: Warehouse) {
    const now = new Date().toISOString();
    await db.warehouses.put({
      ...w,
      active: w.active === 1 ? 0 : 1,
      updated_at: now,
      entity_version: (w.entity_version ?? 0) + 1,
    });
    refresh();
  }

  if (loading) return <div className="p-6 text-slate-500">Loading...</div>;
  if (!businessId) return <div className="p-6 text-slate-600">No active business.</div>;

  return (
    <div className="p-6 flex flex-col gap-4 max-w-4xl">
      <h1 className="text-xl font-semibold">Warehouses</h1>

      <section className="border border-slate-200 rounded p-4 bg-white">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          {editingId ? 'Edit warehouse' : 'Add warehouse'}
        </h2>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="col-span-1 flex flex-col">
            <span className="text-slate-600 mb-1">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label className="col-span-1 flex flex-col">
            <span className="text-slate-600 mb-1">Address</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5"
            />
          </label>
          <label className="col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            <span className="text-slate-700">Default warehouse</span>
          </label>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            className="text-sm bg-slate-900 text-white rounded px-3 py-1.5 hover:bg-slate-800"
          >
            {editingId ? 'Save changes' : 'Add'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={clearForm}
              className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-100"
            >
              Cancel
            </button>
          )}
        </div>
        {error && <div className="mt-2 text-sm text-rose-600">{error}</div>}
      </section>

      <section className="border border-slate-200 rounded bg-white overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Address</th>
              <th className="px-3 py-2">Default</th>
              <th className="px-3 py-2">Active</th>
              <th className="px-3 py-2 w-40"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-slate-400" colSpan={5}>
                  No warehouses yet.
                </td>
              </tr>
            )}
            {rows.map((w) => (
              <tr key={w.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{w.name}</td>
                <td className="px-3 py-2 text-slate-500">{w.address || '—'}</td>
                <td className="px-3 py-2">{w.is_default === 1 ? 'Yes' : ''}</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => toggleActive(w)}
                    className={`text-xs rounded px-2 py-0.5 border ${
                      w.active === 1
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : 'border-slate-300 bg-slate-50 text-slate-500'
                    }`}
                  >
                    {w.active === 1 ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => startEdit(w)}
                    className="action-edit text-xs"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
