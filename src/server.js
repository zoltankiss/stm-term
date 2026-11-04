'use strict';
// stm-term daemon: owns every PTY, enforces the short-term-memory limit, archives evicted tabs
// into long-term memory (tagged by Haiku), and serves the web UI + a control API that agents use for QA.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { openDb } = require('./db');
const procinfo = require('./procinfo');
const tagger = require('./tagger');
const { cleanEnv } = require('./env');
const importer = require('./importer');
const { agents } = require('./agents');
const { Worker } = require('worker_threads');
const search = require('./search');

const PORT = +(process.env.STM_PORT || 4790);
const DATA = process.env.STM_DATA_DIR || path.join(os.homedir(), '.stm-term');
const MAX = +(process.env.STM_MAX || 5);
const SHELL = process.env.STM_SHELL || process.env.SHELL || '/bin/zsh';
const ROOT = path.join(__dirname, '..');
const SESSIONS_DIR = path.join(DATA, 'agent-sessions'); // SessionStart hook records, keyed by tab id
const UPLOADS = path.join(DATA, 'uploads'); // dropped / pasted files, so their paths can be pasted into a tab
const MAX_UPLOAD = 50 * 1024 * 1024;
const IMPORT_CLAUDE = process.env.STM_IMPORT_CLAUDE !== '0';
const ACTIVE_WINDOW = 10 * 60 * 1000; // a session touched this recently may be open in another terminal
// Where a tab starts when there is no focused tab to inherit from: STM_DEFAULT_CWD, else
// "defaultCwd" in <data dir>/config.json (read at startup, so a Finder-launched app gets it too), else ~.
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
function readDefaultCwd() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')); } catch {}
  const want = expandHome(process.env.STM_DEFAULT_CWD || cfg.defaultCwd);
  if (want && fs.existsSync(want)) return want;
  if (want) console.warn(`stm-term: default cwd ${want} does not exist; using ~`);
  return os.homedir();
}

fs.mkdirSync(DATA, { recursive: true });
const db = openDb(path.join(DATA, 'stm.sqlite'));
const DEFAULT_CWD = readDefaultCwd();
// Conversation index (see src/search.js). Opened here first so the schema exists before the worker
// starts; the worker writes, this connection only reads.
const SEARCH_FILE = path.join(DATA, 'search.sqlite');
const sdb = search.open(SEARCH_FILE);
const indexState = { sessions: 0, transcriptBytes: 0, scanning: false, done: 0, total: 0, lastScanMs: null, errors: 0 };
let indexer = null;
function startIndexer() {
  if (process.env.STM_INDEX === '0') return;
  indexer = new Worker(path.join(__dirname, 'index-worker.js'), { workerData: { file: SEARCH_FILE } });
  indexer.unref();
  indexer.on('message', (m) => {
    if (m.type === 'progress') Object.assign(indexState, { scanning: true, done: m.done, total: m.total });
    else if (m.type === 'scanned') {
      Object.assign(indexState, { scanning: false, done: m.done, total: m.total, lastScanMs: m.ms, sessions: m.sessions, transcriptBytes: m.transcriptBytes });
      if (m.bytes) { console.log(`[index] ${m.done} session(s) checked, ${(m.bytes / 1e6).toFixed(1)} MB new transcript in ${m.ms} ms`); memChanged(); }
    } else if (m.type === 'error') { indexState.errors++; console.error('[index]', m.sessionId, m.error); }
  });
  indexer.on('error', (e) => console.error('[index] worker died:', e.message));
}
function indexSessions() {
  if (!indexer) return;
  const sessions = [...tabs.values()].filter((t) => t.agent_session_id && t.state !== 'forgotten' && agents[t.kind])
    .map((t) => ({ sessionId: t.agent_session_id, kind: t.kind }));
  indexState.scanning = true;
  indexer.postMessage({ type: 'scan', sessions });
}
const tabs = new Map(db.all().map((t) => [t.id, t]));
for (const t of tabs.values()) t.agent_session_id = t.agent_session_id || t.claude_session_id || null;
const live = new Map(); // id -> { pty, term, ser, exited }
const clients = new Set();
let memVersion = 0;

const now = () => Date.now();
const stmTabs = () => [...tabs.values()].filter((t) => t.state === 'stm').sort((a, b) => a.position - b.position);
const nextPosition = () => Math.max(0, ...[...tabs.values()].map((t) => t.position || 0)) + 1;
const displayTitle = (t) => t.title || t.osc_title || path.basename(t.cwd || '~') || 'shell';
const save = (t) => db.save(t);

// ---------- state broadcast ----------
function publicTab(t) {
  const L = live.get(t.id);
  return {
    id: t.id, title: displayTitle(t), osc_title: t.osc_title, ai_title: t.title, cwd: t.cwd, state: t.state,
    kind: t.kind, position: t.position, created_at: t.created_at, last_focused_at: t.last_focused_at,
    last_active_at: t.last_active_at, evicted_at: t.evicted_at, tags: t.tags || [], summary: t.summary,
    tag_status: t.tag_status, agent_session_id: t.agent_session_id, import_source: t.import_source || null,
    process: L ? (L.exited ? 'exited' : 'running') : 'snapshot',
    active_elsewhere: !L && !!t.import_source && now() - (t.last_active_at || 0) < ACTIVE_WINDOW,
  };
}
function snapshotState() {
  const stm = stmTabs();
  const byFocus = [...stm].sort((a, b) => a.last_focused_at - b.last_focused_at);
  return {
    max: MAX,
    stm: stm.map(publicTab),
    focusedId: byFocus.length ? byFocus[byFocus.length - 1].id : null,
    nextToEvict: stm.length >= MAX ? byFocus[0].id : null,
    ltmCount: [...tabs.values()].filter((t) => t.state === 'ltm').length,
    memVersion,
  };
}
let stateQueued = false;
function broadcastState() {
  if (stateQueued) return;
  stateQueued = true;
  setImmediate(() => {
    stateQueued = false;
    const msg = JSON.stringify({ type: 'state', state: snapshotState() });
    for (const c of clients) c.send(msg);
  });
}
const memChanged = () => { memVersion++; broadcastState(); };
function sendToAttached(id, msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.attached.has(id)) c.send(s);
}

// ---------- PTYs ----------
function childEnv(id) {
  const env = cleanEnv({ TERM_PROGRAM: 'stm-term', COLORTERM: 'truecolor' });
  for (const k of Object.keys(env)) if (k.startsWith('STM_')) delete env[k];
  env.STM_TAB_ID = id;
  env.STM_SESSIONS_DIR = SESSIONS_DIR;
  return env;
}

function plainText(term, lines = 400) {
  const buf = term.buffer.active;
  // Count back from the last non-blank row, not from the bottom of the buffer: after `clear`
  // the output sits at the top of the screen and the bottom rows are all blank.
  let end = buf.length;
  while (end > 0 && !buf.getLine(end - 1).translateToString(true).trim()) end--;
  const out = [];
  for (let i = Math.max(0, end - lines); i < end; i++) out.push(buf.getLine(i).translateToString(true));
  return out.join('\n');
}

function spawnLive(t, { replay = false, command = null } = {}) {
  const cols = t.cols || 120;
  const rows = t.rows || 32;
  const cwd = t.cwd && fs.existsSync(t.cwd) ? t.cwd : DEFAULT_CWD;
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const ser = new SerializeAddon();
  term.loadAddon(ser);
  if (replay && t.snapshot) {
    const when = new Date(t.last_active_at || t.evicted_at || now()).toLocaleString();
    term.write(`${t.snapshot}\r\n\x1b[2m── restored from long-term memory (process restarted) · last active ${when} ──\x1b[0m\r\n`);
  }
  const p = pty.spawn(SHELL, ['-l'], { name: 'xterm-256color', cols, rows, cwd, env: childEnv(t.id) });
  const L = { pty: p, term, ser, exited: false };
  live.set(t.id, L);
  term.onTitleChange((title) => { t.osc_title = title.slice(0, 120); broadcastState(); });
  p.onData((d) => {
    t.last_active_at = now();
    // Forward only after the mirror has processed the chunk, so attach-snapshots never drop or duplicate data.
    term.write(d, () => sendToAttached(t.id, { type: 'data', id: t.id, data: d }));
  });
  p.onExit(({ exitCode }) => {
    if (live.get(t.id) !== L) return;
    L.exited = true;
    const msg = `\r\n\x1b[2m[process exited (${exitCode}) — press Enter to start a new shell here]\x1b[0m\r\n`;
    term.write(msg, () => sendToAttached(t.id, { type: 'data', id: t.id, data: msg }));
    persistSnapshot(t);
    broadcastState();
  });
  if (command) p.write(`${command}\r`);
  refreshCwd(t);
  return L;
}

function persistSnapshot(t) {
  const L = live.get(t.id);
  if (!L) return;
  t.snapshot = L.ser.serialize({ scrollback: 2000 });
  t.scrollback = plainText(L.term, 400);
  save(t);
}

function refreshAgentSession(t) {
  const loc = agents.codex.locate({ tabId: t.id, sessionsDir: SESSIONS_DIR });
  if (!loc || (t.kind === 'codex' && t.agent_session_id === loc.sessionId)) return;
  if (t.kind === 'shell' || t.kind === 'codex') {
    Object.assign(t, { kind: 'codex', agent_session_id: loc.sessionId });
    save(t);
    broadcastState();
  }
}

async function refreshCwd(t) {
  const L = live.get(t.id);
  if (!L || L.exited) return;
  const cwd = await procinfo.cwdOf(L.pty.pid);
  if (cwd && cwd !== t.cwd) { t.cwd = cwd; save(t); broadcastState(); }
}

function attach(ws, id, cols, rows) {
  const t = tabs.get(id);
  if (!t) return;
  let L = live.get(id);
  if (!L) L = spawnLive(t, { replay: true, command: resumeCommand(t) });
  if (cols && rows) resize(id, cols, rows);
  // Empty write: its callback fires after every pending chunk is processed → consistent snapshot.
  L.term.write('', () => {
    ws.attached.add(id);
    ws.send(JSON.stringify({ type: 'snapshot', id, data: L.ser.serialize() }));
  });
}

function resize(id, cols, rows) {
  const t = tabs.get(id);
  const L = live.get(id);
  if (!t || !L || !(cols > 1 && rows > 1)) return;
  t.cols = cols; t.rows = rows;
  L.term.resize(cols, rows);
  if (!L.exited) L.pty.resize(cols, rows);
}

function input(id, data, { user = false } = {}) {
  const t = tabs.get(id);
  const L = live.get(id);
  if (!t || !L) return;
  if (L.exited) {
    if (!/\r|\n/.test(data)) return;
    persistSnapshot(t);
    live.delete(id);
    spawnLive(t, { replay: true });
    for (const c of clients) if (c.attached.has(id)) attach(c, id);
    return;
  }
  L.pty.write(data);
  if (user && t.state === 'stm') t.last_focused_at = now(); // the human typing counts as "fresh"; agent/API input doesn't
}

// Paste text into a tab the way a terminal does: bracketed if the app asked for it (Claude, Codex,
// and modern shells do), so agents treat a pasted image path as an attachment, not typed keys.
function pasteInto(id, text) {
  const L = live.get(id);
  if (!L || L.exited) return false;
  const bracketed = L.term.modes && L.term.modes.bracketedPasteMode;
  L.pty.write(bracketed ? `\x1b[200~${text}\x1b[201~` : text);
  return true;
}

function saveUpload(name, buf) {
  fs.mkdirSync(UPLOADS, { recursive: true });
  const safe = (path.basename(String(name || 'pasted.png')).replace(/[^\w.-]+/g, '-').replace(/^-+/, '') || 'file').slice(-80);
  const file = path.join(UPLOADS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}-${safe}`);
  fs.writeFileSync(file, buf);
  return file;
}

// Uploads older than a week are pruned at startup; by then the agent has read them.
function pruneUploads() {
  try {
    for (const f of fs.readdirSync(UPLOADS)) {
      const p = path.join(UPLOADS, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400e3) fs.rmSync(p, { force: true });
    }
  } catch {}
}

const readRaw = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let n = 0;
  req.on('data', (c) => { n += c.length; if (n > MAX_UPLOAD) { reject(new Error('file too large (50MB max)')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const resumeCommand = (t) => (agents[t.kind] && t.agent_session_id ? agents[t.kind].resume(t.agent_session_id) : null);

// ---------- memory rules ----------
function createTab({ cwd, agent = null, claude = false, command = null } = {}) {
  agent = agent || (claude ? 'claude' : null);
  if (agent && !agents[agent]) throw new Error(`unknown agent ${agent}`);
  const id = crypto.randomUUID();
  const t = {
    id, title: '', osc_title: '', cwd: cwd || DEFAULT_CWD, state: 'stm', kind: agent || 'shell',
    position: nextPosition(), created_at: now(), last_focused_at: now(), last_active_at: now(),
    tags: [], summary: '', tag_status: 'none', agent_session_id: null, command,
  };
  if (agent) t.command = agents[agent].launch(t);
  tabs.set(id, t);
  save(t);
  spawnLive(t, { command: t.command });
  enforceLimit(id);
  broadcastState();
  return t;
}

function focus(id) {
  const t = tabs.get(id);
  if (!t || t.state !== 'stm') return false;
  t.last_focused_at = now();
  save(t);
  refreshCwd(t);
  broadcastState();
  return true;
}

function enforceLimit(protectId) {
  const stm = stmTabs().filter((t) => t.id !== protectId).sort((a, b) => a.last_focused_at - b.last_focused_at);
  const evicted = [];
  while (stm.length + (protectId ? 1 : 0) > MAX) {
    const t = stm.shift();
    archive(t, { kill: false });
    evicted.push(t.id);
  }
  return evicted;
}

// Move a tab into long-term memory. Eviction keeps the process alive; an explicit close kills it.
function archive(t, { kill }) {
  const L = live.get(t.id);
  persistSnapshot(t);
  t.state = 'ltm';
  t.evicted_at = now();
  t.tag_status = 'pending';
  if (kill && L) { live.delete(t.id); if (!L.exited) L.pty.kill(); }
  save(t);
  memChanged();
  tagTab(t, kill ? null : L);
}

async function tagTab(t, L) {
  try {
    const pid = L && !L.exited ? L.pty.pid : null;
    const info = await procinfo.inspect(pid, t, SESSIONS_DIR);
    if (info.cwd) t.cwd = info.cwd;
    if (info.agent) { t.kind = info.agent.kind; t.agent_session_id = info.agent.sessionId || t.agent_session_id; }
    const out = await tagger.tag({
      title: t.osc_title || displayTitle(t), cwd: t.cwd, git: info.git, processes: info.processes,
      agent: info.agent, scrollback: t.scrollback, previousTags: t.tags,
      produced: t.agent_session_id ? search.producedOf(sdb, t.agent_session_id) : [],
    });
    const keepTitle = t.import_source && t.osc_title; // the agent's own session title beats ours
    Object.assign(t, { title: keepTitle ? t.osc_title : (out.title || t.title), tags: out.tags, summary: out.summary, tag_status: 'done' });
  } catch (e) {
    t.tag_status = 'error';
    t.summary = t.summary || `tagging failed: ${String(e.message || e).slice(0, 120)}`;
    console.error('[tagger]', e.message || e);
  }
  if (tabs.has(t.id)) { save(t); memChanged(); }
}

// Background tagging for imported sessions: newest first, a couple at a time.
const tagQueue = new Set();
let tagRunning = 0;
const TAG_CONCURRENCY = +(process.env.STM_TAG_CONCURRENCY || 2);
function queueTag(t) { tagQueue.add(t.id); pumpTags(); }
function pumpTags() {
  while (tagRunning < TAG_CONCURRENCY && tagQueue.size) {
    const next = [...tagQueue].map((id) => tabs.get(id)).filter(Boolean)
      .sort((a, b) => (b.last_active_at || 0) - (a.last_active_at || 0))[0];
    if (!next) { tagQueue.clear(); return; }
    tagQueue.delete(next.id);
    if (next.state !== 'ltm') continue;
    tagRunning++;
    next.tag_status = 'pending';
    memChanged();
    tagTab(next, null).finally(() => { tagRunning--; pumpTags(); });
  }
}

const importHooks = {
  create(fields) {
    const t = {
      id: crypto.randomUUID(), state: 'ltm', position: 0,
      last_focused_at: 0, evicted_at: fields.last_active_at, tags: [], summary: '', tag_status: 'queued',
      ...fields, osc_title: fields.native_title || '',
    };
    tabs.set(t.id, t);
    save(t);
    queueTag(t);
  },
  update(t, fields) {
    Object.assign(t, fields, { osc_title: fields.native_title || t.osc_title || '', evicted_at: fields.last_active_at });
    // Still being worked on elsewhere: mark stale and re-tag once it settles, not every minute.
    t.tag_status = now() - fields.last_active_at < ACTIVE_WINDOW ? 'stale' : 'queued';
    save(t);
    if (t.tag_status === 'queued') queueTag(t);
  },
};
function runImport() {
  if (!IMPORT_CLAUDE) return;
  let n = 0;
  try { n = importer.scan(tabs, importHooks); } catch (e) { console.error('[import]', e); }
  for (const t of tabs.values()) {
    if (t.state === 'ltm' && t.tag_status === 'stale' && now() - (t.last_active_at || 0) >= ACTIVE_WINDOW) { t.tag_status = 'queued'; queueTag(t); }
  }
  if (n) { console.log(`[import] ${n} Claude session(s) new/updated`); memChanged(); }
}

function restore(id) {
  const t = tabs.get(id);
  if (!t) return null;
  if (t.state === 'stm') { focus(id); return { restored: t, evicted: [] }; }
  t.state = 'stm';
  t.position = nextPosition();
  t.last_focused_at = now();
  if (!live.has(id)) spawnLive(t, { replay: true, command: resumeCommand(t) });
  save(t);
  const evicted = enforceLimit(id);
  memChanged();
  return { restored: t, evicted };
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t || t.state !== 'stm') return false;
  archive(t, { kill: true });
  return true;
}

function forget(id) {
  const t = tabs.get(id);
  if (!t) return false;
  const L = live.get(id);
  if (L && !L.exited) L.pty.kill();
  live.delete(id);
  if (t.agent_session_id) {
    if (indexer) indexer.postMessage({ type: 'forget', sessionId: t.agent_session_id });
    // Tombstone, so the Claude-session importer doesn't bring it back on the next scan.
    Object.assign(t, { state: 'forgotten', snapshot: null, scrollback: '', tags: [], summary: '' });
    save(t);
  } else {
    tabs.delete(id);
    db.remove(id);
  }
  memChanged();
  return true;
}

// Recency for the sidebar: the later of last activity and when it left the tab bar, so a tab you
// just closed is at the top even if it had been idle for an hour.
const recency = (t) => Math.max(t.last_active_at || 0, t.evicted_at || 0);

// With a query, results come back best first:
//   - Something the session produced (a URL, branch or file it introduced) pins it to the top, at any
//     age, when the query looks like an identifier (a digit, dot or slash: round7, a URL, a path) and
//     the match is specific (5 or fewer sessions): "which session made this link". For plain words
//     ("multiple coupons") it only adds to the score; an old file name shouldn't outrank today's work.
//   - Everything else gets one score: how much matches, times how recently the session was active
//     (half-life a week, never below 10%). Matching the title or tags adds most, the amount of the
//     conversation that matches adds the rest, the last screen alone adds little. Recency matters
//     because you are usually looking for the session you were in, not the one from two months ago.
//   - A ticket is a feature. When the title/tag matches mostly share a ticket tag (trend-1828), every
//     session carrying that tag counts as a match ("same ticket"), even if it never names the query:
//     a session titled "gift card refund QA" is still the coupons feature if it's TREND-1828.
// Each result says where it matched and shows the matching text.
const DAY = 86_400_000;
const TICKET_TAG = /^[a-z]{2,10}-\d{3,6}$/;
const IDENTIFIER = /[\d./]/;
const freshness = (t) => 0.1 + 0.9 * 0.5 ** ((now() - recency(t)) / (7 * DAY));

function searchMemory(q, tag) {
  let rows = [...tabs.values()].filter((t) => t.state === 'ltm');
  if (tag) rows = rows.filter((r) => (r.tags || []).includes(tag));
  const tagCounts = {};
  for (const t of tabs.values()) if (t.state === 'ltm') for (const g of t.tags || []) tagCounts[g] = (tagCounts[g] || 0) + 1;
  if (!(q && q.trim() && search.WORDS(q).length)) {
    rows.sort((a, b) => recency(b) - recency(a));
    return { items: rows.map(publicTab), tagCounts };
  }
  const meta = new Set(db.searchIds(q, ['title', 'tags', 'summary']) || []);
  const screen = new Set(db.searchIds(q) || []);
  let convo = new Map();
  let made = new Map();
  try { convo = search.searchConversations(sdb, q); made = search.searchProduced(sdb, q); } catch (e) { console.error('[search]', e.message); }
  const SPECIFIC = 5;
  if (made.size > SPECIFIC) made = new Map();

  // Tickets most title/tag matches share: at least two of them, and a quarter of all such matches.
  const metaRows = rows.filter((t) => meta.has(t.id));
  const ticketCount = new Map();
  for (const t of metaRows) for (const g of new Set(t.tags || [])) if (TICKET_TAG.test(g)) ticketCount.set(g, (ticketCount.get(g) || 0) + 1);
  const topicTickets = new Set([...ticketCount].filter(([, n]) => n >= 2 && n >= metaRows.length * 0.25).map(([g]) => g));

  const hits = [];
  for (const t of rows) {
    const sid = t.agent_session_id;
    const c = sid && convo.get(sid);
    const m = sid && made.get(sid);
    const ticket = (t.tags || []).find((g) => topicTickets.has(g));
    let where = null;
    let strength = 0;
    if (meta.has(t.id)) { where = 'title'; strength += 3; } else if (ticket) { where = 'ticket'; strength += 2; }
    if (c) { where = where || 'conversation'; strength += Math.log1p(c.chunks) * (c.spread ? 0.6 : 1); }
    if (!where && screen.has(t.id)) { where = 'screen'; strength += 0.5; }
    if (m) { where = 'produced'; strength += 4; }
    if (!where) continue;
    hits.push({ t, where, pinned: !!m && IDENTIFIER.test(q), made: m, ticket, score: strength * freshness(t), chunks: c ? c.chunks : 0, best: c ? c.best : null });
  }
  hits.sort((a, b) => (b.pinned - a.pinned) || (a.pinned ? recency(b.t) - recency(a.t) : b.score - a.score));
  const items = hits.slice(0, 200).map(({ t, where, made: m, ticket, chunks, best }, i) => {
    let text = m ? m.join('  ·  ') : '';
    let textFrom = m ? 'produced' : null;
    if (!text && i < 60 && best) {
      try { text = search.snippet(sdb, q, best); textFrom = 'conversation'; } catch {}
    }
    return { ...publicTab(t), match: { where, text, textFrom, chunks, ticket: where === 'ticket' ? ticket : undefined } };
  });
  return { items, tagCounts, ranked: true };
}

// ---------- HTTP ----------
const STATIC = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
};
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  // Anti DNS-rebinding + anti CSRF: only local Host, and mutations need a custom header
  // (forces a CORS preflight we never approve).
  if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'bad host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    return fs.createReadStream(path.join(ROOT, file)).pipe(res);
  }
  if (!p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (req.method !== 'GET' && req.headers['x-stm'] !== '1') return json(res, 403, { error: 'missing x-stm header' });
  // Raw-body upload: POST /api/upload?name=x.png[&tab=<id>] → saves the file; with tab, pastes its path there.
  if (p === '/api/upload' && req.method === 'POST') {
    try {
      const buf = await readRaw(req);
      if (!buf.length) return json(res, 400, { error: 'empty body' });
      const file = saveUpload(url.searchParams.get('name'), buf);
      const tab = url.searchParams.get('tab');
      const pasted = tab ? pasteInto(tab, `${file} `) : false;
      return json(res, 200, { path: file, bytes: buf.length, pasted });
    } catch (e) { return json(res, 413, { error: String(e.message || e) }); }
  }
  const body = req.method === 'GET' ? {} : await readBody(req);
  let m;
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, pid: process.pid, data: DATA, max: MAX, defaultCwd: DEFAULT_CWD, index: indexState });
    if (p === '/api/state') return json(res, 200, snapshotState());
    if (p === '/api/memory' && req.method === 'GET') return json(res, 200, searchMemory(url.searchParams.get('q'), url.searchParams.get('tag')));
    if (p === '/api/tabs' && req.method === 'POST') return json(res, 200, publicTab(createTab(body)));
    if ((m = p.match(/^\/api\/tabs\/([\w-]+)$/)) && req.method === 'GET') {
      const t = tabs.get(m[1]);
      return t ? json(res, 200, publicTab(t)) : json(res, 404, { error: 'no such tab' });
    }
    if ((m = p.match(/^\/api\/tabs\/([\w-]+)\/text$/))) {
      const t = tabs.get(m[1]);
      if (!t) return json(res, 404, { error: 'no such tab' });
      const L = live.get(t.id);
      const lines = +(url.searchParams.get('lines') || 200);
      return json(res, 200, { id: t.id, text: L ? plainText(L.term, lines) : (t.scrollback || '').split('\n').slice(-lines).join('\n') });
    }
    if ((m = p.match(/^\/api\/tabs\/([\w-]+)\/focus$/))) return json(res, focus(m[1]) ? 200 : 404, snapshotState());
    if ((m = p.match(/^\/api\/tabs\/([\w-]+)\/input$/))) { input(m[1], String(body.data || '')); return json(res, 200, { ok: true }); }
    if ((m = p.match(/^\/api\/tabs\/([\w-]+)\/paste$/))) return json(res, pasteInto(m[1], String(body.text || '')) ? 200 : 404, { ok: true });
    if ((m = p.match(/^\/api\/tabs\/([\w-]+)\/close$/))) return json(res, closeTab(m[1]) ? 200 : 404, snapshotState());
    if ((m = p.match(/^\/api\/memory\/([\w-]+)\/restore$/))) {
      const r = restore(m[1]);
      return r ? json(res, 200, { restored: publicTab(r.restored), evicted: r.evicted }) : json(res, 404, { error: 'no such tab' });
    }
    if ((m = p.match(/^\/api\/memory\/([\w-]+)\/retag$/))) {
      const t = tabs.get(m[1]);
      if (!t) return json(res, 404, { error: 'no such tab' });
      t.tag_status = 'pending'; memChanged(); tagTab(t, live.get(t.id));
      return json(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/memory\/([\w-]+)$/)) && req.method === 'DELETE') return json(res, forget(m[1]) ? 200 : 404, { ok: true });
    if (p === '/api/shutdown' && req.method === 'POST') { json(res, 200, { ok: true }); return shutdown(); }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: String(e.message || e) });
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (!allowedHosts.has(req.headers.host) || (origin && !allowedOrigins.has(origin)) || !req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.attached = new Set();
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'state', state: snapshotState() }));
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'attach') attach(ws, m.id, m.cols, m.rows);
      else if (m.type === 'detach') ws.attached.delete(m.id);
      else if (m.type === 'input') input(m.id, m.data, { user: true });
      else if (m.type === 'resize') resize(m.id, m.cols, m.rows);
      else if (m.type === 'focus') focus(m.id);
    });
  });
});

// ---------- lifecycle ----------
// Periodic snapshot + title/cwd refresh so a crash loses little and the tab bar stays accurate.
setInterval(() => {
  for (const t of stmTabs()) { refreshCwd(t); refreshAgentSession(t); }
}, 3000).unref();
setInterval(() => { runImport(); indexSessions(); }, 60000).unref();
setInterval(() => {
  for (const [id] of live) { const t = tabs.get(id); if (t) persistSnapshot(t); }
}, 20000).unref();

function shutdown() {
  for (const [id, L] of live) {
    const t = tabs.get(id);
    if (t) persistSnapshot(t);
    if (!L.exited) L.pty.kill();
  }
  setTimeout(() => process.exit(0), 100);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stm-term daemon on http://127.0.0.1:${PORT}  data=${DATA}  max=${MAX}  cwd=${DEFAULT_CWD}`);
  // Tabs that were open when the daemon last stopped come back as snapshots with fresh shells.
  for (const t of stmTabs()) if (!live.has(t.id)) spawnLive(t, { replay: true, command: resumeCommand(t) });
  // Drop tags we no longer emit (e.g. claude-code) from older rows.
  for (const t of tabs.values()) if ((t.tags || []).some((g) => tagger.NOISE.has(g))) { t.tags = t.tags.filter((g) => !tagger.NOISE.has(g)); save(t); }
  // Tagging interrupted by a previous shutdown resumes now.
  for (const t of tabs.values()) if (t.state === 'ltm' && ['queued', 'pending', 'error'].includes(t.tag_status)) queueTag(t);
  if (process.env.STM_INSTALL_CODEX_HOOK !== '0') {
    try { console.log(`[codex] SessionStart hook: ${agents.codex.ensureHook()}`); } catch (e) { console.error('[codex] hook install failed', e.message); }
  }
  broadcastState();
  startIndexer();
  setTimeout(() => { runImport(); indexSessions(); }, 200);
  pruneUploads();
});
