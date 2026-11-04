/* global Terminal, FitAddon */
'use strict';
const $ = (s) => document.querySelector(s);
const H = { 'content-type': 'application/json', 'x-stm': '1' };
const api = (method, url, body) => fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

let S = null; // last state from daemon
let ws = null;
let memVersion = -1;
let query = '';
let tagFilter = null;
const terms = new Map(); // id -> { term, fit, el }

const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = { shell: '&gt;_', claude: '✳', codex: '⌬' };
const icon = (kind) => ICON[kind] || ICON.shell;
const MAX_TAGS = 5;
const home = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

function rel(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}
function dayLabel(ts) {
  const d = new Date(ts); const t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const fmt = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return same(d, t) ? `Today · ${fmt}` : same(d, y) ? `Yesterday · ${fmt}` : fmt;
}

// ---------- connection ----------
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { for (const id of terms.keys()) attach(id); };
  ws.onclose = () => setTimeout(connect, 800);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') applyState(m.state);
    else if (m.type === 'snapshot') { const T = terms.get(m.id); if (T) { T.term.reset(); T.term.write(m.data); } }
    else if (m.type === 'data') { const T = terms.get(m.id); if (T) T.term.write(m.data); }
  };
}

// ---------- short-term memory ----------
function ensureTerm(id) {
  if (terms.has(id)) return terms.get(id);
  const el = document.createElement('div');
  el.className = 'term';
  el.dataset.tabId = id;
  el.dataset.testid = 'terminal';
  $('#terms').append(el);
  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", ui-monospace, monospace', fontSize: 13, cursorBlink: true,
    macOptionIsMeta: true, allowProposedApi: true, scrollback: 5000,
    theme: { background: '#16171d', foreground: '#e3e5ea', cursor: '#8ab4f8', selectionBackground: '#3a4660' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  try { fit.fit(); } catch {}
  term.onData((d) => send({ type: 'input', id, data: d }));
  term.onResize(({ cols, rows }) => send({ type: 'resize', id, cols, rows }));
  term.attachCustomKeyEventHandler((e) => !(e.metaKey && (/^[wWkK1-5]$/.test(e.key) || e.code === 'KeyT')));
  const T = { term, fit, el };
  terms.set(id, T);
  attach(id);
  return T;
}
function attach(id) {
  const T = terms.get(id);
  if (!T) return;
  send({ type: 'attach', id, cols: T.term.cols, rows: T.term.rows });
}
function dropTerm(id) {
  const T = terms.get(id);
  if (!T) return;
  send({ type: 'detach', id });
  T.term.dispose();
  T.el.remove();
  terms.delete(id);
}

let shownId = null;
function show(id) {
  for (const [tid, T] of terms) T.el.classList.toggle('active', tid === id);
  const T = terms.get(id);
  if (T) {
    try { T.fit.fit(); } catch {}
    if (shownId !== id || document.activeElement === document.body) T.term.focus();
  }
  shownId = id;
  $('#empty').hidden = !!id;
}

function applyState(s) {
  S = s;
  const ids = new Set(s.stm.map((t) => t.id));
  for (const id of [...terms.keys()]) if (!ids.has(id)) dropTerm(id);
  for (const t of s.stm) ensureTerm(t.id);
  renderTabs();
  show(s.focusedId);
  if (s.memVersion !== memVersion) { memVersion = s.memVersion; loadMemory(); }
  $('#ltm-count').textContent = s.ltmCount;
}

function renderTabs() {
  $('#tabs').innerHTML = S.stm.map((t, i) => `
    <div class="tab ${t.kind} ${t.id === S.nextToEvict ? 'next-out' : ''}" role="tab" tabindex="0" data-testid="stm-tab" data-id="${t.id}"
      aria-selected="${t.id === S.focusedId}" title="${esc(t.title)} — ${esc(home(t.cwd))}  (⌘${i + 1})">
      <span class="k">${icon(t.kind)}</span>
      <span class="n">${esc(t.title)}</span>
      ${t.process === 'exited' ? '<span class="dead" title="process exited">●</span>' : ''}
      ${t.id === S.nextToEvict ? '<span class="evict" data-testid="next-evict" title="Stalest tab: opening another moves it to long-term memory">↓</span>' : ''}
      <span class="x" data-close="${t.id}" data-testid="close-tab" title="Close (⌘W): archive and stop process">×</span>
    </div>`).join('');
  $('#slots').innerHTML = Array.from({ length: S.max }, (_, i) => `<i class="${i < S.stm.length ? 'on' : ''}"></i>`).join('');
  $('#slots').title = `${S.stm.length} / ${S.max} short-term slots`;
}

function focusTab(id) {
  if (!id) return;
  S.focusedId = id;
  renderTabs();
  show(id);
  send({ type: 'focus', id });
}

$('#tabs').addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { api('POST', `/api/tabs/${close.dataset.close}/close`); return; }
  const tab = e.target.closest('.tab');
  if (tab) focusTab(tab.dataset.id);
});
$('#new-shell').onclick = () => newTab(false);
$('#new-claude').onclick = () => newTab('claude');
$('#new-codex').onclick = () => newTab('codex');
function newTab(agent) {
  const cur = S && S.stm.find((t) => t.id === S.focusedId);
  api('POST', '/api/tabs', { agent: agent || undefined, cwd: cur ? cur.cwd : undefined });
}

// ---------- long-term memory ----------
let memSeq = 0;
async function loadMemory() {
  const qs = new URLSearchParams();
  if (query) qs.set('q', query);
  if (tagFilter) qs.set('tag', tagFilter);
  // Responses can arrive out of order (a broad query is slower than the next one typed); only the
  // latest request may render, or the list shows results for a query that is no longer in the box.
  const seq = ++memSeq;
  const { items, tagCounts, ranked } = await api('GET', `/api/memory?${qs}`);
  if (seq !== memSeq) return;
  renderMemory(items, tagCounts, ranked);
}

// Matching text from the server marks hits with \u0002…\u0003; escape first, then highlight.
const highlight = (s) => esc(s).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');
const WHERE = { produced: 'made', title: 'title', ticket: 'same ticket', conversation: 'said', screen: 'screen' };
const WHY = {
  produced: 'This session introduced it',
  title: 'Title, tags or summary match',
  ticket: 'Shares a ticket with the sessions whose titles match',
  conversation: 'Matches in the conversation',
  screen: 'Only its last screen matches',
};
function matchLine(m) {
  if (!m) return '';
  const label = (w, extra = '') => `<span class="where ${w}" title="${WHY[w]}${extra}">${WHERE[w]}</span>`;
  // The label says why it matched; when the text shown is from somewhere else, say that too.
  let labels = label(m.where, m.where === 'conversation' ? ` (${m.chunks} part(s))` : m.ticket ? ` (${m.ticket})` : '');
  if (m.textFrom === 'conversation' && m.where !== 'conversation') labels += label('conversation', ` (${m.chunks} part(s))`);
  return `<div class="hit" data-testid="match">${labels}${m.text ? highlight(m.text) : ''}</div>`;
}

function renderMemory(items, tagCounts, ranked) {
  $('#filter').hidden = !tagFilter;
  $('#filter-chip').textContent = tagFilter || '';
  const top = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  $('#top-tags').innerHTML = tagFilter ? '' : top.map(([t, n]) => `<button class="tag" data-tag="${esc(t)}" title="${n} tab(s)">${esc(t)}</button>`).join('');
  if (!items.length) {
    $('#ltm-list').innerHTML = `<div class="ltm-empty">${query || tagFilter ? 'Nothing in memory matches.' : 'Nothing here yet. When you open a 6th tab, the stalest one moves here.'}</div>`;
    return;
  }
  let html = '';
  let lastDay = '';
  if (ranked) html += `<div class="day">Best matches · ${items.length}</div>`;
  for (const t of items) {
    const ts = Math.max(t.last_active_at || 0, t.evicted_at || 0);
    const day = dayLabel(ts);
    if (!ranked && day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; }
    const tags = t.tag_status === 'pending' || (t.tag_status === 'queued' && !t.tags.length)
      ? `<span class="tagging" data-testid="tagging">${t.tag_status === 'pending' ? 'tagging…' : 'queued for tagging'}</span>`
      : t.tags.slice(0, MAX_TAGS).map((g) => `<button class="tag ${g === tagFilter ? 'active' : ''}" data-tag="${esc(g)}" data-testid="mem-tag">${esc(g)}</button>`).join('')
        + (t.tags.length > MAX_TAGS ? `<span class="more" title="${esc(t.tags.slice(MAX_TAGS).join(', '))}">+${t.tags.length - MAX_TAGS}</span>` : '')
        + (t.tag_status === 'error' ? `<button class="tag-error" data-retag="${t.id}" data-testid="retag" title="${esc(t.summary)}">tagging failed · retry</button>` : '');
    html += `
      <div class="mem ${t.kind}" role="listitem" data-testid="memory-item" data-id="${t.id}" title="Click to bring back into short-term memory">
        <div class="icon">${icon(t.kind)}</div>
        <div>
          <div class="t">${esc(t.title)}</div>
          ${t.summary ? `<div class="s">${esc(t.summary)}</div>` : ''}
          ${matchLine(t.match)}
          <div class="p">${esc(home(t.cwd))}</div>
          <div class="tags">${tags}</div>
        </div>
        <div class="right">
          <span class="time" title="${esc(new Date(ts).toLocaleString())}">${rel(ts)}</span>
          ${t.active_elsewhere
            ? '<span class="status elsewhere" title="This Claude session was active in the last 10 minutes; it may still be open in another terminal">active elsewhere</span>'
            : `<span class="status ${t.process}" title="${t.process === 'running' ? 'process still running in the background' : t.kind === 'claude' ? `restores with ${t.kind} resume` : 'saved snapshot; a new shell starts on restore'}">${t.process === 'running' ? '● live' : t.import_source ? `${t.import_source} session` : 'snapshot'}</span>`}
          <button class="forget" data-forget="${t.id}" title="Forget permanently" data-testid="forget">×</button>
        </div>
      </div>`;
  }
  $('#ltm-list').innerHTML = html;
}

function setTag(tag) {
  tagFilter = tagFilter === tag ? null : tag;
  loadMemory();
}
$('#ltm').addEventListener('click', (e) => {
  const tagBtn = e.target.closest('[data-tag]');
  if (tagBtn) { e.stopPropagation(); setTag(tagBtn.dataset.tag); return; }
  if (e.target.closest('#filter-chip')) { setTag(tagFilter); return; }
  const retag = e.target.closest('[data-retag]');
  if (retag) { e.stopPropagation(); api('POST', `/api/memory/${retag.dataset.retag}/retag`); return; }
  const forget = e.target.closest('[data-forget]');
  if (forget) { api('DELETE', `/api/memory/${forget.dataset.forget}`); return; }
  const item = e.target.closest('.mem');
  if (item) api('POST', `/api/memory/${item.dataset.id}/restore`);
});
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { query = e.target.value; loadMemory(); }, 120);
});

// ---------- keys ----------
document.addEventListener('keydown', (e) => {
  if (!e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === 't' || e.code === 'KeyT') { e.preventDefault(); newTab(e.altKey ? 'codex' : e.shiftKey ? 'claude' : null); }
  else if (k === 'w' && S && S.focusedId) { e.preventDefault(); api('POST', `/api/tabs/${S.focusedId}/close`); }
  else if (k === 'k') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
  else if (/^[1-5]$/.test(k) && S && S.stm[+k - 1]) { e.preventDefault(); focusTab(S.stm[+k - 1].id); }
}, true);

// ---------- drag & drop / paste files (images for Claude & Codex) ----------
// Like Terminal/iTerm: dropping a file pastes its path. Bytes go to the daemon (works in a plain
// browser too, where file paths aren't exposed), which saves them and pastes the saved path.
// Backslash-escape like Terminal.app does on drop (macOS screenshot names contain spaces).
const shellEscape = (p) => p.replace(/([ \\'"()&;!$`*?<>|#~{}[\]])/g, '\\$1');
async function uploadInto(id, files, { preferRealPath = false } = {}) {
  if (!id || !files.length) return;
  const T = terms.get(id);
  const paths = [];
  for (const f of files) {
    // In the desktop app a dropped Finder file has a real path: paste that, exactly like other terminals.
    const real = preferRealPath && window.stmNative ? window.stmNative.pathForFile(f) : null;
    if (real) { paths.push(shellEscape(real)); continue; }
    const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name || 'pasted.png')}`, {
      method: 'POST', headers: { 'x-stm': '1', 'content-type': f.type || 'application/octet-stream' }, body: f,
    }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    if (r.path) paths.push(r.path); else console.warn('upload failed', r.error);
  }
  if (T && paths.length) { T.term.paste(`${paths.join(' ')} `); T.term.focus(); }
}
const hasFiles = (dt) => dt && [...(dt.types || [])].includes('Files');
const tabAt = (target) => { const el = target && target.closest && target.closest('.term'); return el ? el.dataset.tabId : null; };
let dragDepth = 0;
// Always prevent the default, or Electron/Chrome navigates away to show the dropped file.
document.addEventListener('dragover', (e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
document.addEventListener('dragenter', (e) => { if (hasFiles(e.dataTransfer)) { dragDepth++; $('#terms').classList.add('dropping'); } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#terms').classList.remove('dropping'); } });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#terms').classList.remove('dropping');
  const id = tabAt(e.target) || (S && S.focusedId);
  uploadInto(id, [...e.dataTransfer.files], { preferRealPath: true });
});
// ⌘V with an image (e.g. ⌃⇧⌘4 screenshot) on the clipboard: xterm only pastes text, so handle files here.
document.addEventListener('paste', (e) => {
  const dt = e.clipboardData;
  if (!dt || !dt.files || !dt.files.length || dt.getData('text/plain')) return;
  if (!tabAt(document.activeElement) && !tabAt(e.target)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  uploadInto(S && S.focusedId, [...dt.files]);
}, true);

window.addEventListener('resize', () => { if (shownId && terms.get(shownId)) terms.get(shownId).fit.fit(); });
setInterval(() => { if (memVersion >= 0) loadMemory(); }, 60000); // keep "N min ago" fresh
connect();
