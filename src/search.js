'use strict';
// Full-text index of every agent session's conversation, in its own database (<data>/search.sqlite)
// so it can be deleted and rebuilt at any time without touching memory itself.
//
// What is indexed: the human's messages, the agent's replies, and the inputs of its tool calls
// (commands, file paths, URLs). Tool *outputs* are not: they are most of a transcript's bytes and
// mostly noise for "which session worked on X".
//
// Sessions are stored as ~16KB chunks, appended as the transcript grows (only new bytes are read).
// A session's score is the sum over its matching chunks, so the session that did the work outranks
// one that mentioned the word once.
//
// "Produced" = URLs the agent reported in its replies, branches it created or pushed, and files it
// wrote, minus anything the human pasted in first. URLs that only appear in tool inputs (an API it
// curled, a page it opened) are read, not produced. A specific hit there ranks above the conversation.
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { isHuman } = require('./agents/common');

const INDEX_VERSION = 2; // bump when extraction changes: the index is rebuilt from the transcripts
const CHUNK = 16_000;
const READ_BLOCK = 8 * 1024 * 1024;
const FIELD_MAX = 1500;
const MAX_PRODUCED = 2000;

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v !== INDEX_VERSION) {
    db.exec('DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS produced;');
    db.exec(`PRAGMA user_version=${INDEX_VERSION}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      session_id TEXT PRIMARY KEY, kind TEXT, file TEXT, offset INTEGER DEFAULT 0,
      tail_rowid INTEGER, tail_text TEXT DEFAULT '', user_urls TEXT DEFAULT '[]', produced TEXT DEFAULT '[]'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(session_id UNINDEXED, body);
    CREATE VIRTUAL TABLE IF NOT EXISTS produced USING fts5(session_id UNINDEXED, items);
  `);
  return db;
}

// ---------- extraction ----------
const URL_RE = /https?:\/\/[^\s"'`<>()[\]{}\\]+/g;
const cleanUrl = (u) => u.replace(/[.,;:!?*_]+$/, '');
const urls = (text) => (String(text).match(URL_RE) || []).map(cleanUrl);
const BRANCH_RES = [
  /git\s+(?:checkout|switch)\s+-[bcBC]\s+([\w./-]+)/g,
  /git\s+worktree\s+add\s+(?:-q\s+)?-b\s+([\w./-]+)/g,
  /ts-worktree\s+([\w./-]+)/g,
  /git\s+push\s+(?:-\S+\s+)*\S+\s+(?:HEAD:)?([\w./-]+)/g,
];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const TEMP_PATH = /^(\/private)?\/(tmp|var\/folders)\//;

const trimStrings = (v) => {
  if (typeof v === 'string') return v.length > FIELD_MAX ? `${v.slice(0, FIELD_MAX)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map(trimStrings);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimStrings(x)]));
  return v;
};
const flatten = (v) => (typeof v === 'string' ? v : Object.values(v || {}).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// One transcript line -> [{ role: 'user'|'agent'|'tool', text, tool?, input? }]
function claudeParts(line) {
  if (line.includes('"type":"tool_result"')) return []; // tool output: skip without parsing
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return [];
  let e;
  try { e = JSON.parse(line); } catch { return []; }
  if (e.isSidechain || !e.message) return [];
  const c = e.message.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  const out = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text' && b.text) {
      if (e.type === 'user') { if (isHuman(b.text.trim())) out.push({ role: 'user', text: b.text.trim() }); }
      else out.push({ role: 'agent', text: b.text.trim() });
    } else if (b.type === 'tool_use' && e.type === 'assistant') {
      const input = trimStrings(b.input || {});
      out.push({ role: 'tool', tool: b.name, input, text: flatten(input) });
    }
  }
  return out;
}

function codexParts(line) {
  if (!line.includes('"user_message"') && !line.includes('"response_item"')) return [];
  let e;
  try { e = JSON.parse(line); } catch { return []; }
  const p = e.payload || {};
  if (e.type === 'event_msg' && p.type === 'user_message') {
    const t = String(p.message || '').trim();
    return isHuman(t) ? [{ role: 'user', text: t }] : [];
  }
  if (e.type !== 'response_item') return [];
  if (p.type === 'message' && p.role === 'assistant') {
    const t = (p.content || []).map((x) => x.text || '').join('\n').trim();
    return t ? [{ role: 'agent', text: t }] : [];
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
    let input = p.arguments || p.input || p.action || {};
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { input }; } }
    input = trimStrings(input);
    return [{ role: 'tool', tool: p.name || p.type, input, text: flatten(input) }];
  }
  return [];
}

const PARTS = { claude: claudeParts, codex: codexParts };

function producedFrom(part, userUrls) {
  const found = [];
  if (part.role === 'user') return found;
  if (part.role === 'agent') for (const u of urls(part.text)) if (!userUrls.has(u)) found.push(u);
  if (part.role === 'tool') {
    const fp = part.input && part.input.file_path;
    if (WRITE_TOOLS.has(part.tool) && typeof fp === 'string' && !TEMP_PATH.test(fp)) found.push(fp);
    const cmd = typeof part.input.command === 'string' ? part.input.command : Array.isArray(part.input.command) ? part.input.command.join(' ') : '';
    for (const re of BRANCH_RES) for (const m of cmd.matchAll(re)) if (!/^-/.test(m[1]) && m[1] !== 'HEAD') found.push(`branch:${m[1]}`);
  }
  return found;
}

// Index the bytes appended to one transcript since the last pass. Returns bytes consumed.
function indexFile(db, { sessionId, kind, file }) {
  const parts = PARTS[kind];
  if (!parts) return 0;
  let row = db.prepare('SELECT * FROM files WHERE session_id = ?').get(sessionId);
  let size;
  try { size = fs.statSync(file).size; } catch { return 0; }
  if (row && (row.file !== file || size < row.offset)) { removeSession(db, sessionId); row = null; } // moved or rewritten
  if (row && size === row.offset) return 0;
  const st = row || { offset: 0, tail_rowid: null, tail_text: '', user_urls: '[]', produced: '[]' };
  const userUrls = new Set(JSON.parse(st.user_urls));
  const produced = new Set(JSON.parse(st.produced));
  let tail = st.tail_text || '';
  const full = [];
  const fd = fs.openSync(file, 'r');
  let offset = st.offset;
  try {
    let carry = Buffer.alloc(0);
    while (offset + carry.length < size) {
      const len = Math.min(READ_BLOCK, size - offset - carry.length);
      const block = Buffer.alloc(len);
      fs.readSync(fd, block, 0, len, offset + carry.length);
      const buf = carry.length ? Buffer.concat([carry, block]) : block;
      const nl = buf.lastIndexOf(0x0a);
      if (nl < 0) { carry = buf; continue; }
      for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
        if (!line) continue;
        for (const p of parts(line)) {
          if (p.role === 'user') for (const u of urls(p.text)) userUrls.add(u);
          else if (produced.size < MAX_PRODUCED) for (const x of producedFrom(p, userUrls)) produced.add(x);
          tail += `${p.role === 'user' ? 'USER' : p.role === 'agent' ? 'AGENT' : `TOOL ${p.tool}`}: ${p.text}\n`;
          if (tail.length >= CHUNK) { full.push(tail); tail = ''; }
        }
      }
      offset += nl + 1;
      carry = buf.subarray(nl + 1);
      if (offset + carry.length >= size) break; // only a partial line left: next pass
    }
  } finally { fs.closeSync(fd); }

  const consumed = offset - st.offset;
  db.exec('BEGIN');
  try {
    if (st.tail_rowid) db.prepare('DELETE FROM chunks WHERE rowid = ?').run(st.tail_rowid);
    const ins = db.prepare('INSERT INTO chunks (session_id, body) VALUES (?, ?)');
    for (const c of full) ins.run(sessionId, c);
    const tailRowid = tail ? Number(ins.run(sessionId, tail).lastInsertRowid) : null;
    db.prepare('DELETE FROM produced WHERE session_id = ?').run(sessionId);
    if (produced.size) db.prepare('INSERT INTO produced (session_id, items) VALUES (?, ?)').run(sessionId, [...produced].join('\n'));
    db.prepare(`INSERT OR REPLACE INTO files (session_id, kind, file, offset, tail_rowid, tail_text, user_urls, produced)
      VALUES (?,?,?,?,?,?,?,?)`).run(sessionId, kind, file, offset, tailRowid, tail, JSON.stringify([...userUrls].slice(-500)), JSON.stringify([...produced]));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return consumed;
}

function removeSession(db, sessionId) {
  db.prepare('DELETE FROM chunks WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM produced WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM files WHERE session_id = ?').run(sessionId);
}

// ---------- queries ----------
const WORDS = (q) => (String(q || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 12);
const ftsExpr = (words) => words.map((w) => `"${w}"*`).join(' ');
const MARK_OPEN = '\u0002';
const MARK_CLOSE = '\u0003';

// Sum bm25 per session (in JS: SQLite flattens a GROUP BY over bm25() into an aggregate context,
// where bm25() is not allowed) and remember each session's best chunk for the snippet.
function scoreSessions(db, expr) {
  const out = new Map();
  for (const r of db.prepare('SELECT rowid, session_id, bm25(chunks) AS s FROM chunks WHERE chunks MATCH ?').iterate(expr)) {
    const cur = out.get(r.session_id) || { score: 0, chunks: 0, best: r.rowid, bestScore: r.s };
    cur.score += r.s;
    cur.chunks++;
    if (r.s < cur.bestScore) { cur.best = r.rowid; cur.bestScore = r.s; }
    out.set(r.session_id, cur);
  }
  return out;
}

/** sessionId -> { score, chunks, best, spread } for conversation hits; more negative score = better.
 *  All words in one chunk first; then (spread: true) sessions with every word somewhere in them. */
function searchConversations(db, q, limit = 400) {
  const words = WORDS(q);
  if (!words.length) return new Map();
  const near = scoreSessions(db, ftsExpr(words));
  const out = [...near].sort((a, b) => a[1].score - b[1].score);
  if (words.length > 1) {
    const per = words.map((w) => scoreSessions(db, ftsExpr([w])));
    const spread = [];
    for (const [sid, first] of per[0]) {
      if (near.has(sid) || !per.every((m) => m.has(sid))) continue;
      spread.push([sid, { score: per.reduce((acc, m) => acc + m.get(sid).score, 0), chunks: first.chunks, best: first.best, spread: true }]);
    }
    out.push(...spread.sort((a, b) => a[1].score - b[1].score));
  }
  return new Map(out.slice(0, limit));
}

/** sessionId -> [matching produced items] */
function searchProduced(db, q) {
  const words = WORDS(q);
  if (!words.length) return new Map();
  const out = new Map();
  for (const r of db.prepare('SELECT session_id, items FROM produced WHERE produced MATCH ?').all(ftsExpr(words))) {
    const hits = r.items.split('\n').filter((it) => { const l = it.toLowerCase(); return words.every((w) => l.includes(w)); });
    if (hits.length) out.set(r.session_id, hits.slice(0, 3));
  }
  return out;
}

// Snippet from one chunk, built here rather than with FTS5 snippet(): that needs a MATCH, which
// re-reads the whole doclist for every result (seconds for a common prefix across 60 results).
// Picks the ~200-char window with the most distinct query words, words matched as prefixes. It starts
// ~20 chars before the first hit: the sidebar shows three narrow lines, and the hit must be in them.
function snippet(db, q, rowid, width = 200) {
  const words = WORDS(q);
  if (!words.length || !rowid) return '';
  // BigInt: node:sqlite binds a JS number as REAL, which turns the rowid lookup into a scan.
  const r = db.prepare('SELECT body FROM chunks WHERE rowid = ?').get(BigInt(rowid));
  if (!r) return '';
  const body = r.body;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${words.map(esc).join('|')})[\\p{L}\\p{N}_]*`, 'giu');
  const hits = [];
  for (const m of body.matchAll(re)) {
    const lineStart = body.lastIndexOf('\n', m.index) + 1;
    // Prefer what a person or the agent said over a command line that happens to contain the word.
    const prose = !body.startsWith('TOOL ', lineStart);
    hits.push({ at: m.index, end: m.index + m[0].length, w: m[1].toLowerCase(), prose });
    if (hits.length >= 400) break;
  }
  if (!hits.length) return '';
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < hits.length; i++) {
    const seen = new Set();
    for (let j = i; j < hits.length && hits[j].at - hits[i].at < width * 0.7; j++) seen.add(hits[j].w);
    const score = seen.size * 2 + (hits[i].prose ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  let from = Math.max(0, hits[best].at - 20); // the sidebar shows ~3 narrow lines; the hit must be in them
  const space = body.indexOf(' ', from);
  if (from > 0 && space > from && space < hits[best].at) from = space + 1; // start on a word
  const to = Math.min(body.length, from + width);
  let out = '';
  let pos = from;
  for (const h of hits) {
    if (h.at < from || h.end > to) continue;
    out += body.slice(pos, h.at) + MARK_OPEN + body.slice(h.at, h.end) + MARK_CLOSE;
    pos = h.end;
  }
  out = (out + body.slice(pos, to)).replace(/\s+/g, ' ');
  return `${from > 0 ? '…' : ''}${out.trim()}${to < body.length ? '…' : ''}`;
}

function producedOf(db, sessionId, n = 15) {
  const r = db.prepare('SELECT produced FROM files WHERE session_id = ?').get(sessionId);
  return r ? JSON.parse(r.produced).filter((x) => !x.startsWith('/')).slice(-n) : [];
}

function stats(db) {
  const f = db.prepare('SELECT count(*) AS sessions, coalesce(sum(offset),0) AS bytes FROM files').get();
  return { sessions: f.sessions, transcriptBytes: f.bytes };
}

module.exports = {
  open, indexFile, removeSession, searchConversations, searchProduced, snippet, producedOf, stats,
  WORDS, MARK_OPEN, MARK_CLOSE, INDEX_VERSION,
};
