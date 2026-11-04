// Agent-native QA: spins up an isolated daemon (own port, own temp data dir) and drives the UI
// in a headless Chromium. Nothing appears on screen and nothing touches your real ~/.stm-term.
//   node test/qa.mjs            fake tagger (fast, deterministic)
//   STM_QA_REAL=1 node test/qa.mjs   real Haiku tagging via `claude -p`
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solidPng } from './png.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4800 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const ART = path.join(ROOT, '.qa-artifacts');
const REAL = !!process.env.STM_QA_REAL;
fs.mkdirSync(ART, { recursive: true });

let data = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-qa-'));
// Fixture Claude Code transcripts: one interactive session (should import), one SDK session (should not).
const FIX_SID = '11111111-2222-4333-8444-555555555555';
const fixDir = path.join(data, 'claude-projects', '-fixture-foxtrot');
fs.mkdirSync(fixDir, { recursive: true });
const line = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(path.join(fixDir, `${FIX_SID}.jsonl`),
  line({ type: 'user', entrypoint: 'cli', cwd: '/tmp/foxtrot-billing', sessionId: FIX_SID, gitBranch: 'main', message: { role: 'user', content: 'Migrate foxtrot billing webhooks to the new queue' } })
  + line({ type: 'assistant', entrypoint: 'cli', cwd: '/tmp/foxtrot-billing', sessionId: FIX_SID, message: { role: 'assistant', content: [{ type: 'text', text: 'Moved the webhook handler onto the queue; tests pass.' }] } })
  + line({ type: 'ai-title', aiTitle: 'Foxtrot billing webhook queue migration', sessionId: FIX_SID }));
// Search fixtures. Session A says "zebrafish" early, long before its last screen, then reports a
// URL it published; it also curls an API (read, not produced). Session B is someone pasting A's URL.
const SEARCH_A = '22222222-2222-4333-8444-555555555555';
const SEARCH_B = '33333333-2222-4333-8444-555555555555';
const turn = (sid, role, content) => line({ type: role, entrypoint: 'cli', cwd: '/tmp/hotel-ledger', sessionId: sid, message: { role, content } });
const filler = Array.from({ length: 30 }, (_, i) => turn(SEARCH_A, 'assistant', [{ type: 'text', text: `Step ${i}: compared ledger lines for the hotel group against the bank export; totals agree for this batch. `.repeat(6) }])).join('');
fs.writeFileSync(path.join(fixDir, `${SEARCH_A}.jsonl`),
  turn(SEARCH_A, 'user', 'Reconcile the hotel ledger for October')
  + turn(SEARCH_A, 'assistant', [{ type: 'text', text: 'The zebrafish vendor code is the odd one out; it has no matching bank line.' }])
  + turn(SEARCH_A, 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl -s https://api.example.test/readonly/ledger' } }])
  + line({ type: 'user', entrypoint: 'cli', cwd: '/tmp/hotel-ledger', sessionId: SEARCH_A, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'kangaroo output that must not be indexed' }] } })
  + turn(SEARCH_A, 'assistant', [{ type: 'text', text: 'Published the report: https://ledger-round9.example.test/' }])
  + filler);
fs.writeFileSync(path.join(fixDir, `${SEARCH_B}.jsonl`),
  turn(SEARCH_B, 'user', 'can you check https://ledger-round9.example.test/ please')
  + turn(SEARCH_B, 'assistant', [{ type: 'text', text: 'Looked at https://ledger-round9.example.test/ and it loads.' }]));
// Ranking fixtures: three sessions on ticket proj-4242 (the tag comes from the cwd). Two have "walrus"
// in their title, one 30 days old; the third never says "walrus" but is the same ticket.
const WALRUS_OLD = '55555555-2222-4333-8444-555555555555';
const WALRUS_NEW = '66666666-2222-4333-8444-555555555555';
const SAME_TICKET = '77777777-2222-4333-8444-555555555555';
const walrus = (sid, title, ask, ageDays) => {
  const f = path.join(fixDir, `${sid}.jsonl`);
  const turn = (role, content) => line({ type: role, entrypoint: 'cli', cwd: '/tmp/proj-4242', sessionId: sid, message: { role, content } });
  fs.writeFileSync(f, turn('user', ask) + turn('assistant', [{ type: 'text', text: 'On it.' }]) + line({ type: 'ai-title', aiTitle: title, sessionId: sid }));
  const t = new Date(Date.now() - ageDays * 86_400_000);
  fs.utimesSync(f, t, t);
};
walrus(WALRUS_OLD, 'Walrus ledger export', 'Export the walrus ledger', 30);
walrus(WALRUS_NEW, 'Walrus totals check', 'Check the walrus totals', 0);
walrus(SAME_TICKET, 'Gift card refund QA', 'QA the gift card refunds for proj-4242', 0);
// Interactive sessions the importer should bring in (the SDK one below is skipped).
const IMPORTS = 7;
fs.writeFileSync(path.join(fixDir, '99999999-2222-4333-8444-555555555555.jsonl'),
  line({ type: 'user', entrypoint: 'sdk-cli', cwd: '/tmp/observer', message: { role: 'user', content: 'background observer prompt' } }));
// Default tab directory comes from config.json (the path a Finder-launched app relies on).
const DEFAULT_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stm-qa-home-')));
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ defaultCwd: DEFAULT_DIR }));
// Fixture Codex home: one interactive TUI session (import, titled via session_index), one `codex exec` (skip).
const CODEX_SID = '01a1cccc-1111-7222-8333-444444444444';
const codexHome = path.join(data, 'codex-home');
const cxDir = path.join(codexHome, 'sessions', '2026', '11', '01');
fs.mkdirSync(cxDir, { recursive: true });
fs.writeFileSync(path.join(cxDir, `rollout-2026-11-01T10-00-00-${CODEX_SID}.jsonl`),
  line({ type: 'session_meta', payload: { id: CODEX_SID, cwd: '/tmp/golf-ledger', originator: 'codex-tui', source: 'cli' } })
  + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions ...' }] } })
  + line({ type: 'event_msg', payload: { type: 'user_message', message: 'Reconcile the golf ledger CSV against Stripe payouts' } })
  + line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found 3 payouts missing from the ledger.' }] } }));
fs.writeFileSync(path.join(cxDir, 'rollout-2026-11-01T11-00-00-01a1dddd-1111-7222-8333-444444444444.jsonl'),
  line({ type: 'session_meta', payload: { id: '01a1dddd-1111-7222-8333-444444444444', cwd: '/tmp/x', originator: 'codex_exec', source: 'exec' } })
  + line({ type: 'event_msg', payload: { type: 'user_message', message: 'non-interactive exec job' } }));
fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), line({ id: CODEX_SID, thread_name: 'Golf ledger Stripe reconciliation', updated_at: '2026-11-01T10:05:00Z' }));
// Fake `codex` binary: behaves like Codex's SessionStart hook firing, then idles. Prints its args.
const FAKE_CODEX_SID = '01a1eeee-1111-7222-8333-444444444444';
const fakeBin = path.join(data, 'bin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/bin/sh
echo "FAKE-CODEX args: $*"
sid=${FAKE_CODEX_SID}
[ "$1" = resume ] && sid=$2
printf '{"session_id":"%s","transcript_path":"","cwd":"%s","hook_event_name":"SessionStart"}' "$sid" "$PWD" | ${path.join(ROOT, 'bin', 'agent-session-hook.sh')} codex
echo "fake codex ready"
exec sleep 600
`, { mode: 0o755 });
let daemon;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (method, p, body) => fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-stm': '1' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
async function until(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(step); }
  return last;
}

function startDaemon() {
  daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: ROOT, env: { ...process.env, STM_PORT: String(PORT), STM_DATA_DIR: data, STM_TAGGER: REAL ? 'claude' : 'fake', STM_SHELL: '/bin/zsh', STM_CLAUDE_PROJECTS: path.join(data, 'claude-projects'), STM_ALLOW_TEMP_CWD: '1', STM_CODEX_HOME: codexHome, STM_CODEX_BIN: path.join(fakeBin, 'codex') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`));
  return until(() => fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false), 10000);
}
async function stopDaemon() {
  await api('POST', '/api/shutdown').catch(() => {});
  await new Promise((r) => daemon.once('exit', r));
}

async function main() {
  await startDaemon();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForSelector('#empty:not([hidden])');
  check('empty state shown on fresh data dir', true);

  // 0. Existing Claude Code sessions are imported into long-term memory (interactive only).
  const imported = await until(async () => {
    const m = await api('GET', '/api/memory');
    return m.items.length >= IMPORTS && m.items.every((x) => x.tag_status === 'done') && m.items;
  }, REAL ? 60000 : 8000);
  const fx = imported && imported.find((x) => x.agent_session_id === FIX_SID);
  const cx = imported && imported.find((x) => x.agent_session_id === CODEX_SID);
  check('interactive Codex session imported (title from session_index), exec skipped', !!cx && cx.kind === 'codex' && cx.title === 'Golf ledger Stripe reconciliation',
    cx ? `"${cx.title}" [${cx.tags.join(', ')}]` : 'missing');
  const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
  check('Codex SessionStart hook installed into hooks.json', JSON.stringify(hooksJson).includes('agent-session-hook.sh'));
  check('interactive Claude session imported + tagged, SDK session skipped', imported && imported.length === IMPORTS && !!fx && fx.tags.length > 0,
    imported ? `${imported.length} item(s): "${fx && fx.title}" [${fx && fx.tags.join(', ')}]` : 'timeout');
  check('imported session keeps Claude ai-title', fx && fx.title === 'Foxtrot billing webhook queue migration');
  await page.fill('[data-testid=ltm-search]', 'webhook queue');
  await until(async () => (await page.locator('[data-testid=memory-item]').count()) === 1, 3000);
  check('search finds imported session by transcript text', await page.locator(`[data-testid=memory-item][data-id="${fx && fx.id}"]`).count() === 1);
  await page.fill('[data-testid=ltm-search]', '');

  // 0b. Conversation search: the whole transcript is indexed, not just the last screen.
  const idx = await until(async () => { const h = await api('GET', '/api/health'); return h.index && !h.index.scanning && h.index.sessions >= IMPORTS && h.index; }, 15000);
  check('conversation index covers every imported session', !!idx, idx ? `${idx.sessions} session(s), ${idx.transcriptBytes} bytes` : 'timeout');
  const q = (s) => api('GET', `/api/memory?q=${encodeURIComponent(s)}`);
  const zebra = await q('zebrafish');
  const za = zebra.items.find((x) => x.agent_session_id === SEARCH_A);
  check('a word from early in a long session is found (not on its last screen)', !!za && za.match.where === 'conversation' && za.match.text.includes('\u0002zebrafish\u0003'),
    za ? `${za.match.where}: ${za.match.text.slice(0, 80)}` : `${zebra.items.length} result(s)`);
  const r9 = await q('round9');
  check('the session that published a URL ranks first, as "produced"', r9.items[0] && r9.items[0].agent_session_id === SEARCH_A && r9.items[0].match.where === 'produced',
    r9.items.map((x) => `${x.agent_session_id.slice(0, 8)}:${x.match.where}`).join(' '));
  const bAt = r9.items.findIndex((x) => x.agent_session_id === SEARCH_B);
  check('a session that only had the URL pasted in is found, below and not as "produced"', bAt > 0 && r9.items[bAt].match.where !== 'produced', bAt >= 0 ? r9.items[bAt].match.where : 'missing');
  const read = await q('api.example.test');
  check('a URL the agent only read (curl) is not "produced"', read.items.some((x) => x.agent_session_id === SEARCH_A) && !read.items.some((x) => x.match.where === 'produced'));
  check('tool output is not indexed', (await q('kangaroo')).items.length === 0);
  check('search results are ranked (no day headings)', r9.ranked === true);
  const wal = await q('walrus');
  const at = (sid) => wal.items.findIndex((x) => x.agent_session_id === sid);
  check('recency: of two equal title matches, the recent one ranks first', at(WALRUS_NEW) >= 0 && at(WALRUS_OLD) > at(WALRUS_NEW), `new #${at(WALRUS_NEW) + 1}, old #${at(WALRUS_OLD) + 1}`);
  const same = wal.items[at(SAME_TICKET)];
  check('a session on the same ticket matches though it never says the word', !!same && same.match.where === 'ticket' && same.match.ticket === 'proj-4242', same ? JSON.stringify(same.match).slice(0, 80) : 'missing');
  check('...and today\'s same-ticket session outranks a 30-day-old title match', at(SAME_TICKET) < at(WALRUS_OLD));
  await page.fill('[data-testid=ltm-search]', 'zebrafish');
  const mark = await until(async () => {
    const items = page.locator('[data-testid=memory-item]');
    if (await items.count() !== 1 || await items.first().getAttribute('data-id') !== za.id) return false;
    return (await page.locator('[data-testid=match] mark').allInnerTexts()).includes('zebrafish');
  }, 3000);
  check('search result shows the matching text, highlighted', !!mark);
  await page.screenshot({ path: path.join(ART, '00-search-snippet.png') });
  await page.fill('[data-testid=ltm-search]', '');

  // 1. Open 5 shells through the UI, each in a distinct project dir, tag each with a marker.
  const dirs = ['alpha-api', 'bravo-web', 'charlie-infra', 'delta-docs', 'echo-ml'].map((n) => {
    const d = path.join(data, 'projects', n); fs.mkdirSync(d, { recursive: true }); return d;
  });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    await page.click('[data-testid=new-shell]');
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid=stm-tab]').length === n, i + 1);
    const st = await api('GET', '/api/state');
    const id = st.focusedId;
    ids.push(id);
    // Type through the real xterm (keyboard → websocket → pty), not the API.
    await page.locator(`.term[data-tab-id="${id}"] .xterm-helper-textarea`).focus();
    await page.keyboard.type(`cd ${dirs[i]} && echo MARKER-${i}-$((6*7))\n`);
    const ok = await until(async () => (await api('GET', `/api/tabs/${id}/text`)).text.includes(`MARKER-${i}-42`));
    check(`tab ${i + 1}: typed command ran in pty`, !!ok);
  }
  const st5 = await api('GET', '/api/state');
  check('5 tabs open, slots full', st5.stm.length === 5, `${st5.stm.length}/${st5.max}`);
  check('UI renders xterm output', await page.locator(`.term[data-tab-id="${ids[4]}"]`).innerText().then((t) => t.includes('MARKER-4-42')));

  // 2. Touch tabs so tab[2] is the stalest: focus order 0,1,3,4 (2 untouched since creation... 0 & 1 refreshed after it).
  for (const i of [0, 1, 3, 4]) { await page.click(`[data-testid=stm-tab][data-id="${ids[i]}"]`); await sleep(60); }
  const stTouched = await api('GET', '/api/state');
  check('"next out" marker on the stalest tab', stTouched.nextToEvict === ids[2] && await page.locator(`[data-testid=stm-tab][data-id="${ids[2]}"] [data-testid=next-evict]`).count() === 1);
  await page.screenshot({ path: path.join(ART, '01-five-tabs.png') });

  // Start a long-running process in the soon-to-be-evicted tab to prove it survives eviction.
  await api('POST', `/api/tabs/${ids[2]}/input`, { data: 'for i in $(seq 1 600); do echo tick-$i; sleep 0.2; done\n' });
  await sleep(800);

  // 3. Open a 6th → stalest moves to long-term memory, gets tagged, process keeps running.
  await page.click('[data-testid=new-shell]');
  const st6 = await until(async () => { const s = await api('GET', '/api/state'); return s.stm.length === 5 && !s.stm.find((t) => t.id === ids[2]) && s; });
  check('6th tab evicts the stalest (tab 3) and keeps 5', !!st6);
  await page.waitForSelector(`[data-testid=memory-item][data-id="${ids[2]}"]`);
  check('evicted tab appears in long-term memory sidebar', true);
  const tagged = await until(async () => {
    const m = await api('GET', '/api/memory');
    const it = m.items.find((x) => x.id === ids[2]);
    return it && it.tag_status === 'done' && it;
  }, REAL ? 90000 : 10000);
  check('evicted tab gets tags', tagged && tagged.tag_status === 'done' && tagged.tags.length >= 2, tagged ? `${tagged.tag_status}: [${tagged.tags.join(', ')}] "${tagged.title}" — ${tagged.summary}` : 'timeout');
  check('evicted tab cwd captured', tagged && tagged.cwd && tagged.cwd.endsWith('charlie-infra'), tagged && tagged.cwd);
  const t1 = (await api('GET', `/api/tabs/${ids[2]}/text`)).text.match(/tick-(\d+)/g) || [];
  await sleep(1200);
  const t2 = (await api('GET', `/api/tabs/${ids[2]}/text`)).text.match(/tick-(\d+)/g) || [];
  check('evicted process still running in background', t2.length > t1.length && tagged.process === 'running', `${t1.at(-1)} → ${t2.at(-1)}`);
  await page.waitForSelector(`[data-testid=memory-item][data-id="${ids[2]}"] [data-testid=mem-tag]`);
  await page.screenshot({ path: path.join(ART, '02-evicted-tagged.png') });

  // 4. Search + tag filter.
  await page.fill('[data-testid=ltm-search]', 'charlie');
  await until(async () => (await page.locator('[data-testid=memory-item]').count()) === 1, 3000);
  check('search "charlie" finds the evicted tab', await page.locator(`[data-testid=memory-item][data-id="${ids[2]}"]`).count() === 1);
  await page.fill('[data-testid=ltm-search]', 'zzz-nothing-matches');
  await until(async () => (await page.locator('[data-testid=memory-item]').count()) === 0, 3000);
  check('search with no match shows empty list', await page.locator('[data-testid=memory-item]').count() === 0);
  await page.fill('[data-testid=ltm-search]', '');
  await page.waitForSelector(`[data-testid=memory-item][data-id="${ids[2]}"]`);

  // Evict a second tab so tag filtering has something to exclude.
  await page.click('[data-testid=new-shell]');
  await until(async () => (await api('GET', '/api/memory')).items.filter((x) => x.tag_status === 'done').length === IMPORTS + 2, REAL ? 90000 : 10000);
  const mem2 = await api('GET', '/api/memory');
  const target = mem2.items.find((x) => x.id === ids[2]);
  const others = mem2.items.filter((x) => x.id !== ids[2]);
  const uniqueTag = target.tags.find((g) => others.every((o) => !o.tags.includes(g)));
  await page.waitForSelector(`[data-testid=memory-item][data-id="${ids[2]}"] [data-testid=mem-tag]`);
  await page.locator(`[data-testid=memory-item][data-id="${ids[2]}"] [data-testid=mem-tag]`, { hasText: uniqueTag }).first().click();
  await until(async () => (await page.locator('[data-testid=memory-item]').count()) === 1, 3000);
  const filtered = await page.locator('[data-testid=memory-item]').evaluateAll((els) => els.map((e) => e.dataset.id));
  check(`clicking tag "${uniqueTag}" filters memory`, filtered.length === 1 && filtered[0] === ids[2] && await page.locator('#filter:not([hidden])').count() === 1, `${filtered.length} item(s)`);
  await page.screenshot({ path: path.join(ART, '03-tag-filter.png') });
  await page.click('[data-testid=tag-filter]');
  await until(async () => (await page.locator('[data-testid=memory-item]').count()) === 4, 3000);
  check('clearing tag filter shows all', await page.locator('[data-testid=memory-item]').count() === IMPORTS + 2);

  // 5. Click a memory → it comes back to short-term, stalest goes out, live process reattaches.
  const before = await api('GET', '/api/state');
  const expectedOut = before.nextToEvict;
  await page.click(`[data-testid=memory-item][data-id="${ids[2]}"]`);
  const after = await until(async () => { const s = await api('GET', '/api/state'); return s.stm.some((t) => t.id === ids[2]) && s; });
  check('clicking memory restores it to short-term (focused)', after && after.focusedId === ids[2]);
  check('restore evicts the then-stalest tab', after && !after.stm.some((t) => t.id === expectedOut) && after.stm.length === 5);
  const restoredText = await until(async () => {
    const txt = await page.locator(`.term[data-tab-id="${ids[2]}"]`).innerText();
    return /tick-\d+/.test(txt) && txt.includes('MARKER-2-42') && txt;
  }, 5000);
  check('restored tab shows live output + earlier history', !!restoredText);
  await page.screenshot({ path: path.join(ART, '04-restored.png') });

  // 6. Close a tab explicitly → archived + process killed.
  const closeId = after.stm.find((t) => t.id !== ids[2]).id;
  await page.hover(`[data-testid=stm-tab][data-id="${closeId}"]`); // × only shows on hover/selected
  await page.click(`[data-testid=stm-tab][data-id="${closeId}"] [data-testid=close-tab]`);
  const closed = await until(async () => (await api('GET', '/api/memory')).items.find((x) => x.id === closeId && x.process === 'snapshot'));
  check('closing a tab archives it with process stopped', !!closed);

  // 7. Daemon restart: short-term tabs come back from snapshot with fresh shells.
  await stopDaemon();
  await startDaemon();
  await page.reload();
  const rst = await until(async () => { const s = await api('GET', '/api/state'); return s.stm.length === 4 && s; });
  check('after daemon restart, 4 short-term tabs restored', !!rst, rst && `${rst.stm.length}`);
  const restoredAfter = await until(async () => {
    const txt = await page.locator(`.term[data-tab-id="${ids[2]}"]`).innerText().catch(() => '');
    return txt.includes('MARKER-2-42') && txt.includes('restored from long-term memory');
  }, 8000);
  check('snapshot replayed after restart', !!restoredAfter);
  const memAfter = await api('GET', '/api/memory');
  check('long-term memory persisted across restart (no duplicate imports)', memAfter.items.length === IMPORTS + 3, `${memAfter.items.length} items`);

  // Forgetting an imported session sticks across rescans/restarts.
  await api('DELETE', `/api/memory/${fx.id}`);
  await stopDaemon(); await startDaemon();
  await sleep(1500);
  const memForgot = await api('GET', '/api/memory');
  check('forgotten imported session is not re-imported', !memForgot.items.some((x) => x.agent_session_id === FIX_SID), `${memForgot.items.length} items`);
  const hooksAgain = fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8');
  check('hook install is idempotent across restarts', hooksAgain.split('agent-session-hook.sh').length === 2);
  await page.reload();

  // 9. Codex tab: launched from the UI, learns its exact session id from the SessionStart hook,
  //    and after close + restore relaunches `codex resume <that id>`.
  await page.click('[data-testid=new-codex]');
  const cxTab = await until(async () => {
    const s = await api('GET', '/api/state');
    const t = s.stm.find((x) => x.kind === 'codex');
    return t && t.agent_session_id && t;
  }, 10000);
  check('Codex tab learns its session id via SessionStart hook', cxTab && cxTab.agent_session_id === FAKE_CODEX_SID, cxTab && cxTab.agent_session_id);
  check('Codex tab shows ⌬ icon', cxTab && await page.locator(`[data-testid=stm-tab][data-id="${cxTab.id}"].codex`).count() === 1);
  await api('POST', `/api/tabs/${cxTab.id}/close`);
  await until(async () => (await api('GET', '/api/memory')).items.find((x) => x.id === cxTab.id && x.tag_status === 'done'));
  await page.click(`[data-testid=memory-item][data-id="${cxTab.id}"]`);
  const resumed = await until(async () => (await api('GET', `/api/tabs/${cxTab.id}/text`)).text.includes(`FAKE-CODEX args: resume ${FAKE_CODEX_SID} --dangerously-bypass-approvals-and-sandbox`), 10000);
  check('restored Codex tab runs `codex resume <same id>` with bypass flags', !!resumed);
  await page.screenshot({ path: path.join(ART, '06-codex.png') });

  // 10. Images: drag & drop and ⌘V paste. In a plain browser there are no file paths, so bytes are
  //     uploaded to the daemon and the saved path is pasted, bracketed when the app enabled it.
  const png = solidPng();
  await page.click('[data-testid=new-shell]');
  const imgTab = await until(async () => { const s = await api('GET', '/api/state'); const t = s.stm.find((x) => x.kind === 'shell' && x.process === 'running' && x.id === s.focusedId); return t; });
  await api('POST', `/api/tabs/${imgTab.id}/input`, { data: "printf '\\033[?2004h'; cat -v\n" }); // app enables bracketed paste, shows raw bytes
  await sleep(700);
  const b64 = png.toString('base64');
  await page.evaluate(([b64, id]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'Screenshot 2026-11-02 at 7.22.50 PM.png', { type: 'image/png' }));
    const el = document.querySelector(`.term[data-tab-id="${id}"] .xterm-screen`);
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [b64, imgTab.id]);
  const dropped = await until(async () => {
    const m = (await api('GET', `/api/tabs/${imgTab.id}/text`)).text.replace(/\n/g, '').match(/\^\[\[200~(\S+uploads\/\S+\.png) \^\[\[201~/);
    return m && m[1];
  }, 6000);
  check('drag & drop image → saved + path pasted (bracketed)', !!dropped && fs.existsSync(dropped) && fs.readFileSync(dropped).equals(png), dropped || 'no path in tab');
  check('page did not navigate away on drop', page.url().startsWith(BASE));
  await page.evaluate(([b64, id]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    const ta = document.querySelector(`.term[data-tab-id="${id}"] .xterm-helper-textarea`);
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [b64, imgTab.id]);
  const pasted = await until(async () => {
    const all = [...(await api('GET', `/api/tabs/${imgTab.id}/text`)).text.replace(/\n/g, '').matchAll(/\^\[\[200~(\S+uploads\/\S+-image\.png) \^\[\[201~/g)];
    return all.length ? all[all.length - 1][1] : null;
  }, 6000);
  check('⌘V with an image on the clipboard → saved + path pasted', !!pasted && fs.readFileSync(pasted).equals(png), pasted || 'no path');
  const up = await fetch(`${BASE}/api/upload?name=api.png&tab=${imgTab.id}`, { method: 'POST', headers: { 'x-stm': '1' }, body: png }).then((r) => r.json());
  check('API upload with tab= pastes into the tab (agent parity)', up.pasted && await until(async () => (await api('GET', `/api/tabs/${imgTab.id}/text`)).text.replace(/\n/g, '').includes(up.path), 4000));
  const tooBig = await fetch(`${BASE}/api/upload?name=x.bin`, { method: 'POST', headers: { 'x-stm': '1' } , body: Buffer.alloc(0) });
  check('empty upload rejected', tooBig.status === 400);
  await page.screenshot({ path: path.join(ART, '07-image-drop.png') });

  // 8. Security: cross-site mutation without the header is refused; foreign Host is refused.
  const noHeader = await fetch(`${BASE}/api/tabs`, { method: 'POST', body: '{}' });
  check('mutation without x-stm header refused', noHeader.status === 403);
  const badHost = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: { host: 'evil.example' } },
    (res) => { res.resume(); resolve({ status: res.statusCode }); }).on('error', () => resolve({ status: 0 })));
  check('foreign Host header refused', badHost.status === 403);

  // 9. A tab opened with no cwd starts in the configured default; ?lines= counts from the last
  // non-blank row (after `clear` the bottom of the screen is blank).
  const h = await api('GET', '/api/health');
  check('health reports configured default cwd', h.defaultCwd === DEFAULT_DIR, h.defaultCwd);
  const fresh = await api('POST', '/api/tabs', {});
  check('tab with no cwd opens in the default dir', fresh.cwd === DEFAULT_DIR, fresh.cwd);
  await sleep(1500);
  await api('POST', `/api/tabs/${fresh.id}/input`, { data: 'clear; pwd; echo LINES-$((6*7))\r' });
  const tail = await until(async () => { const r = await api('GET', `/api/tabs/${fresh.id}/text?lines=5`); return r.text.includes('LINES-42') && r.text; }, 8000);
  check('?lines=5 returns the output after clear', !!tail);
  check('shell actually started in the default dir', !!tail && tail.includes(DEFAULT_DIR), tail || '');

  await page.screenshot({ path: path.join(ART, '05-after-restart.png') });
  const all = await api('GET', '/api/memory');
  const keys = all.items.map((x) => Math.max(x.last_active_at || 0, x.evicted_at || 0));
  check('memory is sorted by the later of last activity and when it left the tab bar', keys.every((k, i) => i === 0 || keys[i - 1] >= k));
  check('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await browser.close();
  await stopDaemon();
}

main().catch((e) => { check('harness crashed', false, e.stack); })
  .finally(() => {
    try { daemon && daemon.kill(); } catch {}
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${ART}`);
    fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify(results, null, 2));
    process.exit(failed.length ? 1 : 0);
  });
