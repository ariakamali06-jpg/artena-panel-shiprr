import { useEffect, useState, type FormEvent } from 'react';
import { Check, Plus, Shield, Trash2, UserCheck, X } from 'lucide-react';
import { apiRequest, formatTimestamp } from '../lib/api';

interface PermissionDef {
  key: string;
  label: string;
  group: string;
}

interface SubAdmin {
  id: string;
  username: string;
  role: 'admin';
  active: boolean;
  permissions: string[];
  allowedInbounds: string[];
  note: string;
  createdAt: string;
}

interface AdminRequest {
  id: string;
  username: string;
  contact: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export function AdminsView({
  onToast,
}: {
  onToast: (type: 'success' | 'error' | 'info', msg: string) => void;
}) {
  const [admins, setAdmins] = useState<SubAdmin[]>([]);
  const [requests, setRequests] = useState<AdminRequest[]>([]);
  const [permissions, setPermissions] = useState<PermissionDef[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [selectedPerms, setSelectedPerms] = useState<string[]>(['dashboard', 'inbounds', 'client_create']);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [aRes, rRes, pRes] = await Promise.all([
      apiRequest<{ admins: SubAdmin[] }>('/api/admins').catch(() => ({ admins: [] })),
      apiRequest<{ requests: AdminRequest[] }>('/api/admin-requests').catch(() => ({ requests: [] })),
      apiRequest<{ permissions: PermissionDef[] }>('/api/permissions').catch(() => ({ permissions: [] })),
    ]);
    setAdmins(aRes.admins || []);
    setRequests(rRes.requests || []);
    setPermissions(pRes.permissions || []);
  };

  useEffect(() => {
    void load();
  }, []);

  const togglePerm = (key: string) => {
    setSelectedPerms((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const createAdmin = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiRequest('/api/admins', {
        method: 'POST',
        body: { username, password, note, permissions: selectedPerms },
      });
      onToast('success', `Sub-admin "${username}" created`);
      setUsername('');
      setPassword('');
      setNote('');
      setShowCreate(false);
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to create admin');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (admin: SubAdmin) => {
    try {
      await apiRequest(`/api/admins/${admin.id}`, { method: 'PATCH', body: { active: !admin.active } });
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to update admin');
    }
  };

  const deleteAdmin = async (id: string, name: string) => {
    try {
      await apiRequest(`/api/admins/${id}`, { method: 'DELETE' });
      onToast('info', `Removed sub-admin "${name}"`);
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to delete admin');
    }
  };

  const approveReq = async (id: string) => {
    try {
      await apiRequest(`/api/admin-requests/${id}/approve`, {
        method: 'POST',
        body: { permissions: ['dashboard', 'inbounds', 'client_create', 'client_edit'] },
      });
      onToast('success', 'Access request approved');
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Approval failed');
    }
  };

  const rejectReq = async (id: string) => {
    try {
      await apiRequest(`/api/admin-requests/${id}/reject`, { method: 'POST' });
      onToast('info', 'Request rejected');
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Reject failed');
    }
  };

  return (
    <div className="space-y-6">
      {/* Sub-Admins Table */}
      <div className="artena-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center shrink-0">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Sub-Administrators & RBAC
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Delegate Artena operational access with 19 granular permissions and per-inbound scopes
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="h-9 px-3.5 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20 transition-all"
          >
            <Plus className="w-3.5 h-3.5" /> Add Sub-Admin
          </button>
        </div>

        {admins.length === 0 ? (
          <p className="text-xs text-slate-500 py-10 text-center">No sub-administrators created yet.</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {admins.map((a) => (
              <div key={a.id} className="py-3.5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{a.username}</span>
                    <span
                      className={`text-[11px] font-mono font-medium ${
                        a.active ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400'
                      }`}
                    >
                      · {a.active ? 'Active' : 'Suspended'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono">
                    {a.permissions.length} permission(s) · Created {formatTimestamp(a.createdAt)}
                  </p>
                  {a.note && <p className="text-xs text-slate-500 mt-1">{a.note}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void toggleActive(a)}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    {a.active ? 'Suspend' : 'Reactivate'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteAdmin(a.id, a.username)}
                    aria-label={`Delete ${a.username}`}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Access Requests Queue */}
      <div className="artena-card p-6">
        <div className="flex items-center gap-2.5 mb-4">
          <div className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-300 flex items-center justify-center">
            <UserCheck className="w-4 h-4" />
          </div>
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Access Request Queue
          </h3>
        </div>
        {requests.length === 0 ? (
          <p className="text-xs text-slate-500 py-8 text-center">No incoming access requests.</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {requests.map((r) => (
              <div key={r.id} className="py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <span className="font-semibold text-slate-900 dark:text-slate-100 mr-2">{r.username}</span>
                  <span className="font-mono text-[11px] uppercase text-slate-500">{r.status}</span>
                  <p className="text-slate-500 mt-0.5">
                    {r.contact || 'No contact'} · {r.reason || 'No reason provided'}
                  </p>
                </div>
                {r.status === 'pending' && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void approveReq(r.id)}
                      className="px-3 py-1.5 rounded-lg bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] font-medium inline-flex items-center gap-1"
                    >
                      <Check className="w-3.5 h-3.5" /> Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void rejectReq(r.id)}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 inline-flex items-center gap-1"
                    >
                      <X className="w-3.5 h-3.5" /> Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Sub-Admin Modal */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setShowCreate(false)}
        >
          <div
            className="w-full max-w-lg artena-card p-6 shadow-2xl max-h-[90vh] overflow-y-auto artena-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Create Sub-Administrator
              </h3>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                aria-label="Close"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={createAdmin} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Username</label>
                  <input
                    type="text"
                    required
                    minLength={3}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Password</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Note</label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Operations engineer"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    Granular Permissions ({selectedPerms.length}/{permissions.length})
                  </p>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setSelectedPerms(permissions.map((p) => p.key))}
                      className="text-teal-600 dark:text-teal-400 hover:underline"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedPerms([])}
                      className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 max-h-52 overflow-y-auto p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                  {permissions.map((p) => (
                    <label
                      key={p.key}
                      className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedPerms.includes(p.key)}
                        onChange={() => togglePerm(p.key)}
                        className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                      <span className="truncate">{p.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="h-9 px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="h-9 px-4 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium shadow-sm shadow-teal-600/20"
                >
                  {saving ? 'Creating...' : 'Create Sub-Admin'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
