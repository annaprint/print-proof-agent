import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Edit, Estimate, LayoutIssue, Order, ProfileRules } from '@/lib/types';
import { findAcceptedClash } from '@/lib/decide-guard';

const DATA_DIR = path.join(process.cwd(), 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'printproof.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  estimate_json TEXT,
  client_profile_id INTEGER,
  text_hash TEXT,
  document_revision INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  original TEXT NOT NULL,
  suggested TEXT NOT NULL,
  context_before TEXT NOT NULL DEFAULT '',
  context_after TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'normal',
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  source_module TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending',
  decided_at TEXT,
  decided_by TEXT
);
CREATE TABLE IF NOT EXISTS layout_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  page INTEGER NOT NULL DEFAULT 1,
  block_hint TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'layout',
  severity TEXT NOT NULL DEFAULT 'normal',
  confidence REAL NOT NULL DEFAULT 0.8,
  decision TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS client_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rules_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL, -- source | parsed_text | page_render | export_md | export_docx | protocol
  path TEXT,
  content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// пользователи и роли (ACL): admin | manager | client | designer
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','client','designer')),
  client_profile_id INTEGER, -- для role=client: чей портал
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// миграция: контакты и ответственный менеджер у клиента (клиент = расширенный профиль)
const cpCols = (db.prepare('PRAGMA table_info(client_profiles)').all() as any[]).map((c) => c.name);
if (!cpCols.includes('contact_email')) db.exec('ALTER TABLE client_profiles ADD COLUMN contact_email TEXT');
if (!cpCols.includes('contact_phone')) db.exec('ALTER TABLE client_profiles ADD COLUMN contact_phone TEXT');
if (!cpCols.includes('manager_user_id')) db.exec('ALTER TABLE client_profiles ADD COLUMN manager_user_id INTEGER');

// миграция: bbox для замечаний по макету
const liCols = (db.prepare("PRAGMA table_info(layout_issues)").all() as any[]).map((c) => c.name);
if (!liCols.includes('bbox_json')) {
  db.exec('ALTER TABLE layout_issues ADD COLUMN bbox_json TEXT');
}

// seed: профиль клиента по умолчанию
const profCount = (db.prepare('SELECT COUNT(*) c FROM client_profiles').get() as { c: number }).c;
if (profCount === 0) {
  db.prepare('INSERT INTO client_profiles (name, rules_json, notes) VALUES (?, ?, ?)').run(
    'Acme Co — ё обязательна',
    JSON.stringify({ enforceYo: true, quotes: 'guillemets', brandDictionary: {} } satisfies ProfileRules),
    'Демо-профиль',
  );
}

// seed: демо-пользователи всех ролей
const userCount = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
if (userCount === 0) {
  const ins = db.prepare('INSERT INTO users (name, role, client_profile_id) VALUES (?, ?, ?)');
  ins.run('Администратор', 'admin', null);
  ins.run('А. Доу (менеджер)', 'manager', null);
  const firstProfile = db.prepare('SELECT id FROM client_profiles LIMIT 1').get() as any;
  ins.run('Клиент Acme', 'client', firstProfile?.id ?? null);
  ins.run('Дизайнер', 'designer', null);
}

// --- mappers ---
function rowToOrder(r: any): Order {
  return {
    id: r.id,
    filename: r.filename,
    type: r.type,
    status: r.status,
    estimate: r.estimate_json ? (JSON.parse(r.estimate_json) as Estimate) : null,
    clientProfileId: r.client_profile_id,
    textHash: r.text_hash,
    documentRevision: r.document_revision,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToEdit(r: any): Edit {
  return {
    id: r.id,
    orderId: r.order_id,
    spanStart: r.span_start,
    spanEnd: r.span_end,
    baseRevision: r.base_revision,
    original: r.original,
    suggested: r.suggested,
    contextBefore: r.context_before,
    contextAfter: r.context_after,
    category: r.category,
    severity: r.severity,
    confidence: r.confidence,
    reason: r.reason,
    sourceModule: r.source_module,
    decision: r.decision,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
  };
}

// --- queries ---
export const q = {
  createOrder(filename: string, type: string, clientProfileId: number | null): number {
    const res = db
      .prepare('INSERT INTO orders (filename, type, client_profile_id) VALUES (?, ?, ?)')
      .run(filename, type, clientProfileId);
    return Number(res.lastInsertRowid);
  },
  listOrders(): Order[] {
    return (db.prepare('SELECT * FROM orders ORDER BY id DESC').all() as any[]).map(rowToOrder);
  },
  getOrder(id: number): Order | undefined {
    const r = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    return r ? rowToOrder(r) : undefined;
  },
  updateOrderStatus(id: number, status: string, error?: string | null) {
    db.prepare("UPDATE orders SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?").run(status, error ?? null, id);
  },
  setEstimate(id: number, estimate: Estimate) {
    db.prepare("UPDATE orders SET estimate_json = ?, status = 'estimated', updated_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(estimate),
      id,
    );
  },
  setTextHash(id: number, hash: string) {
    db.prepare('UPDATE orders SET text_hash = ? WHERE id = ?').run(hash, id);
  },
  insertEdits(orderId: number, edits: Omit<Edit, 'orderId' | 'id' | 'decision'>[]) {
    const stmt = db.prepare(`INSERT INTO edits
      (order_id, span_start, span_end, base_revision, original, suggested, context_before, context_after, category, severity, confidence, reason, source_module)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction((rows: typeof edits) => {
      for (const e of rows)
        stmt.run(
          orderId, e.spanStart, e.spanEnd, e.baseRevision, e.original, e.suggested,
          e.contextBefore, e.contextAfter, e.category, e.severity, e.confidence, e.reason, e.sourceModule,
        );
    });
    tx(edits);
  },
  clearUndecidedEdits(orderId: number) {
    db.prepare("DELETE FROM edits WHERE order_id = ? AND decision = 'pending'").run(orderId);
    db.prepare('DELETE FROM layout_issues WHERE order_id = ? AND decision = \'pending\'').run(orderId);
  },
  listEdits(orderId: number): Edit[] {
    return (db.prepare('SELECT * FROM edits WHERE order_id = ? ORDER BY span_start').all(orderId) as any[]).map(rowToEdit);
  },
  getEdit(editId: number): Edit | undefined {
    const r = db.prepare('SELECT * FROM edits WHERE id = ?').get(editId);
    return r ? rowToEdit(r) : undefined;
  },
  updateEditSuggestion(editId: number, suggested: string, reason: string) {
    db.prepare("UPDATE edits SET suggested = ?, reason = ?, decision = 'pending', decided_at = NULL, decided_by = NULL WHERE id = ?").run(
      suggested, reason, editId,
    );
  },
  decideEdit(editId: number, decision: 'accepted' | 'rejected' | 'pending', decidedBy: string) {
    if (decision === 'accepted') {
      const edit = this.getEdit(editId);
      if (edit) {
        const clash = findAcceptedClash(edit, this.listEdits(edit.orderId));
        if (clash) {
          throw new Error(
            `Правка #${editId} пересекается с уже принятой правкой #${clash.id} на этом участке текста — сначала отмените решение по ней`,
          );
        }
      }
    }
    db.prepare("UPDATE edits SET decision = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?").run(decision, decidedBy, editId);
  },
  decideCategory(orderId: number, category: string, decision: 'accepted' | 'rejected', decidedBy: string) {
    db.prepare(
      "UPDATE edits SET decision = ?, decided_at = datetime('now'), decided_by = ? WHERE order_id = ? AND category = ? AND decision = 'pending'",
    ).run(decision, decidedBy, orderId, category);
  },
  decideAll(orderId: number, decision: 'accepted' | 'rejected', decidedBy: string) {
    db.prepare(
      "UPDATE edits SET decision = ?, decided_at = datetime('now'), decided_by = ? WHERE order_id = ? AND decision = 'pending'",
    ).run(decision, decidedBy, orderId);
  },
  decideLayoutIssue(issueId: number, decision: 'accepted' | 'rejected' | 'pending') {
    db.prepare('UPDATE layout_issues SET decision = ? WHERE id = ?').run(decision, issueId);
  },
  insertLayoutIssues(orderId: number, issues: Omit<LayoutIssue, 'orderId' | 'id' | 'decision'>[]) {
    const stmt = db.prepare(
      'INSERT INTO layout_issues (order_id, page, block_hint, description, category, severity, confidence, bbox_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const i of issues)
      stmt.run(orderId, i.page, i.blockHint, i.description, i.category, i.severity, i.confidence, i.bbox ? JSON.stringify(i.bbox) : null);
  },
  listLayoutIssues(orderId: number): LayoutIssue[] {
    return (db.prepare('SELECT * FROM layout_issues WHERE order_id = ?').all(orderId) as any[]).map((r) => ({
      id: r.id, orderId: r.order_id, page: r.page, blockHint: r.block_hint,
      description: r.description, category: r.category, severity: r.severity,
      confidence: r.confidence, decision: r.decision,
      bbox: r.bbox_json ? JSON.parse(r.bbox_json) : null,
    }));
  },
  listProfiles(): { id: number; name: string; rules: ProfileRules; notes?: string; contactEmail?: string; contactPhone?: string; managerUserId?: number | null }[] {
    return (db.prepare('SELECT * FROM client_profiles ORDER BY id').all() as any[]).map((r) => ({
      id: r.id, name: r.name, rules: JSON.parse(r.rules_json), notes: r.notes,
      contactEmail: r.contact_email, contactPhone: r.contact_phone, managerUserId: r.manager_user_id,
    }));
  },
  createProfile(name: string, rules: ProfileRules, notes?: string): number {
    const res = db.prepare('INSERT INTO client_profiles (name, rules_json, notes) VALUES (?, ?, ?)').run(name, JSON.stringify(rules), notes ?? null);
    return Number(res.lastInsertRowid);
  },
  updateProfile(id: number, patch: { name?: string; rules?: ProfileRules; notes?: string }) {
    const cur = db.prepare('SELECT * FROM client_profiles WHERE id = ?').get(id) as any;
    if (!cur) throw new Error(`Профиль #${id} не найден`);
    db.prepare('UPDATE client_profiles SET name = ?, rules_json = ?, notes = ? WHERE id = ?').run(
      patch.name ?? cur.name,
      JSON.stringify(patch.rules ?? JSON.parse(cur.rules_json)),
      patch.notes ?? cur.notes,
      id,
    );
  },
  getProfile(id: number | null): { id: number; name: string; rules: ProfileRules } | undefined {
    if (id == null) {
      const r = db.prepare('SELECT * FROM client_profiles LIMIT 1').get() as any;
      return r ? { id: r.id, name: r.name, rules: JSON.parse(r.rules_json) } : undefined;
    }
    const r = db.prepare('SELECT * FROM client_profiles WHERE id = ?').get(id) as any;
    return r ? { id: r.id, name: r.name, rules: JSON.parse(r.rules_json) } : undefined;
  },
  // --- users (ACL) ---
  listUsers(): { id: number; name: string; role: string; clientProfileId: number | null }[] {
    return (db.prepare('SELECT * FROM users ORDER BY id').all() as any[]).map((r) => ({
      id: r.id, name: r.name, role: r.role, clientProfileId: r.client_profile_id,
    }));
  },
  getUser(id: number) {
    const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    return r ? { id: r.id, name: r.name, role: r.role, clientProfileId: r.client_profile_id } : undefined;
  },
  createUser(name: string, role: string, clientProfileId: number | null): number {
    const res = db.prepare('INSERT INTO users (name, role, client_profile_id) VALUES (?, ?, ?)').run(name, role, clientProfileId);
    return Number(res.lastInsertRowid);
  },
  updateUser(id: number, patch: { name?: string; role?: string; clientProfileId?: number | null }) {
    const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    if (!cur) throw new Error(`Пользователь #${id} не найден`);
    db.prepare('UPDATE users SET name = ?, role = ?, client_profile_id = ? WHERE id = ?').run(
      patch.name ?? cur.name, patch.role ?? cur.role,
      patch.clientProfileId !== undefined ? patch.clientProfileId : cur.client_profile_id, id,
    );
  },
  deleteUser(id: number) {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },
  updateProfileContacts(id: number, patch: { contactEmail?: string; contactPhone?: string; managerUserId?: number | null }) {
    const cur = db.prepare('SELECT * FROM client_profiles WHERE id = ?').get(id) as any;
    if (!cur) throw new Error(`Профиль #${id} не найден`);
    db.prepare('UPDATE client_profiles SET contact_email = ?, contact_phone = ?, manager_user_id = ? WHERE id = ?').run(
      patch.contactEmail ?? cur.contact_email, patch.contactPhone ?? cur.contact_phone,
      patch.managerUserId !== undefined ? patch.managerUserId : cur.manager_user_id, id,
    );
  },
  saveArtifact(orderId: number, kind: string, opts: { path?: string; content?: string }) {
    db.prepare('INSERT INTO artifacts (order_id, kind, path, content) VALUES (?, ?, ?, ?)').run(
      orderId, kind, opts.path ?? null, opts.content ?? null,
    );
  },
  listArtifacts(orderId: number, kind: string): { id: number; path?: string; content?: string }[] {
    return (db.prepare('SELECT * FROM artifacts WHERE order_id = ? AND kind = ? ORDER BY id').all(orderId, kind) as any[]).map((r) => ({
      id: r.id, path: r.path, content: r.content,
    }));
  },
  getArtifact(orderId: number, kind: string): { path?: string; content?: string } | undefined {
    const r = db.prepare('SELECT * FROM artifacts WHERE order_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(orderId, kind) as any;
    return r ? { path: r.path, content: r.content } : undefined;
  },
};

export default db;
