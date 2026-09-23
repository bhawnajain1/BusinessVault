import { useEffect, useState } from 'react';
import { ulid } from 'ulid';
import { db } from '../../db';
import type { Category } from '../../db/types';
import { useActiveBusiness } from '../hooks/useActiveBusiness';

export default function Categories() {
  const { businessId, loading } = useActiveBusiness();
  const [rows, setRows] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!businessId) return;
    const cs = await db.categories.where('business_id').equals(businessId).sortBy('name');
    setRows(cs);
  }

  useEffect(() => {
    refresh();
  }, [businessId]);

  async function save() {
    if (!businessId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    setError(null);
    const now = new Date().toISOString();
    if (editingId) {
      const existing = await db.categories.get(editingId);
      if (!existing) return;
      await db.categories.put({
        ...existing,
        name: trimmed,
        parent_id: parentId || null,
        updated_at: now,
        entity_version: (existing.entity_version ?? 0) + 1,
      });
    } else {
      const dup = rows.find((r) => r.name.toLowerCase() === trimmed.toLowerCase());
      if (dup) {
        setError('A category with that name already exists.');
        return;
      }
      await db.categories.add({
        id: ulid(),
        business_id: businessId,
        name: trimmed,
        parent_id: parentId || null,
        created_at: now,
        updated_at: now,
        entity_version: 1,
      });
    }
    setName('');
    setParentId('');
    setEditingId(null);
    refresh();
  }

  function startEdit(c: Category) {
    setEditingId(c.id);
    setName(c.name);
    setParentId(c.parent_id ?? '');
  }

  async function remove(c: Category) {
    if (!businessId) return;
    const itemCount = await db.items.where('category_id').equals(c.id).count();
    if (itemCount > 0) {
      setError(`Cannot delete — ${itemCount} item(s) still use this category.`);
      return;
    }
    if (!confirm(`Delete category "${c.name}"?`)) return;
    await db.categories.delete(c.id);
    if (editingId === c.id) {
      setEditingId(null);
      setName('');
      setParentId('');
    }
    refresh();
  }

  if (loading) return <div className="p-6 text-slate-500">Loading...</div>;
  if (!businessId) return <div className="p-6 text-slate-600">No active business.</div>;

  return (
    <div className="p-6 flex flex-col gap-4 max-w-4xl">
      <h1 className="text-xl font-semibold">Categories</h1>

      <section className="border border-slate-200 rounded p-4 bg-white">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          {editingId ? 'Edit category' : 'Add category'}
        </h2>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col">
            <span className="text-slate-600 mb-1">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 min-w-[240px]"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-slate-600 mb-1">Parent (optional)</span>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 bg-white min-w-[240px]"
            >
              <option value="">— none —</option>
              {rows
                .filter((c) => c.id !== editingId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
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
              onClick={() => {
                setEditingId(null);
                setName('');
                setParentId('');
                setError(null);
              }}
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
              <th className="px-3 py-2">Parent</th>
              <th className="px-3 py-2 w-40"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-slate-400" colSpan={3}>
                  No categories yet.
                </td>
              </tr>
            )}
            {rows.map((c) => {
              const parent = c.parent_id ? rows.find((r) => r.id === c.parent_id) : null;
              return (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2 text-slate-500">{parent?.name ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => startEdit(c)}
                      className="action-edit mr-3 text-xs"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(c)}
                      className="action-delete text-xs"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
