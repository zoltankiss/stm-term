'use strict';
// Persistence: one row per tab, whether in short-term (open) or long-term (archived) memory.
// node:sqlite (built into Node 22) so there's no native module to rebuild.
const { DatabaseSync } = require('node:sqlite');

const COLS = [
  'id', 'title', 'osc_title', 'cwd', 'state', 'kind', 'position', 'created_at', 'last_focused_at',
  'last_active_at', 'evicted_at', 'tags', 'summary', 'tag_status', 'claude_session_id', 'command',
  'snapshot', 'scrollback', 'cols', 'rows', 'import_source', 'agent_session_id', 'requester',
];

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY, title TEXT DEFAULT '', osc_title TEXT DEFAULT '', cwd TEXT DEFAULT '',
      state TEXT NOT NULL, kind TEXT DEFAULT 'shell', position INTEGER DEFAULT 0,
      created_at INTEGER, last_focused_at INTEGER, last_active_at INTEGER, evicted_at INTEGER,
      tags TEXT DEFAULT '[]', summary TEXT DEFAULT '', tag_status TEXT DEFAULT 'none',
      claude_session_id TEXT, command TEXT, snapshot TEXT, scrollback TEXT DEFAULT '',
      cols INTEGER, rows INTEGER, import_source TEXT, agent_session_id TEXT, requester TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS tabs_fts USING fts5(id UNINDEXED, title, tags, summary, cwd, scrollback);
  `);

  // Migrations for databases created by earlier versions.
  const have = new Set(db.prepare('PRAGMA table_info(tabs)').all().map((c) => c.name));
  if (!have.has('import_source')) db.exec('ALTER TABLE tabs ADD COLUMN import_source TEXT');
  // NULL = never looked at by a tagger that asks who requested the work; '' = looked, nobody else.
  if (!have.has('requester')) db.exec('ALTER TABLE tabs ADD COLUMN requester TEXT');
  if (!have.has('agent_session_id')) {
    // Was Claude-only (claude_session_id); now any agent.
    db.exec('ALTER TABLE tabs ADD COLUMN agent_session_id TEXT');
    db.exec('UPDATE tabs SET agent_session_id = claude_session_id WHERE claude_session_id IS NOT NULL');
  }

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO tabs (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`
  );
  const delFts = db.prepare('DELETE FROM tabs_fts WHERE id = ?');
  const insFts = db.prepare('INSERT INTO tabs_fts (id, title, tags, summary, cwd, scrollback) VALUES (?,?,?,?,?,?)');
  const del = db.prepare('DELETE FROM tabs WHERE id = ?');

  const toRow = (r) => ({ ...r, tags: JSON.parse(r.tags || '[]') });

  return {
    all() {
      return db.prepare('SELECT * FROM tabs').all().map(toRow);
    },
    save(t) {
      upsert.run(...COLS.map((c) => {
        const v = c === 'tags' ? JSON.stringify(t.tags || []) : t[c];
        return v === undefined ? null : v;
      }));
      delFts.run(t.id);
      insFts.run(t.id, `${t.title || ''} ${t.osc_title || ''} ${t.requester || ''}`, (t.tags || []).join(' '), t.summary || '',
        t.cwd || '', t.scrollback || '');
    },
    remove(id) {
      del.run(id);
      delFts.run(id);
    },
    // Prefix-AND full-text search; returns matching ids.
    // Optionally restricted to some columns (e.g. ['title', 'tags', 'summary']).
    searchIds(q, columns = null) {
      const words = (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 12);
      if (!words.length) return null;
      const all = words.map((w) => `"${w}"*`).join(' AND ');
      const expr = columns ? `{${columns.join(' ')}} : (${all})` : all;
      return db.prepare('SELECT id FROM tabs_fts WHERE tabs_fts MATCH ? ORDER BY rank').all(expr).map((r) => r.id);
    },
  };
}

module.exports = { openDb };
