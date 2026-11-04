'use strict';
const fs = require('fs');
const path = require('path');

// Sessions run in throwaway temp dirs (scratchpads, test fixtures) can't be resumed and just add noise.
const TEMP_CWD = /^(\/private)?\/(tmp|var\/folders)\//;
const isHuman = (t) => !!t && !t.startsWith('<') && !t.startsWith('Caveat:') && !t.startsWith('[Request interrupted')
  && !t.startsWith('# AGENTS.md') && !t.startsWith('# Context from my IDE');

const firstToken = (args) => path.basename((args.trim().split(/\s+/)[0]) || '');
// True if `name` is the program being run: `name …`, `/path/name …`, or `node /path/bin/name.js …`.
const runs = (args, name) => firstToken(args) === name
  || new RegExp(`^\\S*node\\s+\\S*/${name}(\\.js)?(\\s|$)`).test(args.trim());

function walk(dir, depth, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try { out.push({ file: p, mtime: fs.statSync(p).mtimeMs }); } catch {}
    }
  }
  return out;
}

// Read the head and tail of a large JSONL file without loading all of it (transcripts can be 200MB+).
function headTail(file, headBytes = 200_000, tailBytes = 400_000) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (start, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, start); return b.toString('utf8'); };
    const parse = (chunk) => chunk.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { head: parse(read(0, Math.min(size, headBytes))), tail: parse(read(Math.max(0, size - tailBytes), Math.min(size, tailBytes))), size };
  } finally { fs.closeSync(fd); }
}

// "FIRST ASK" + recent turns, within a character budget: what tells you why an agent tab mattered.
function excerptFrom(headMsgs, tailMsgs, budget = 6000) {
  const first = headMsgs.find((m) => m.role === 'user');
  // The agent's first answer says what the first ask was about. When the ask was only a screenshot,
  // that answer is the one place in the text that does ("Maryn reports order 44-… shipped …").
  const reply = first ? headMsgs.slice(headMsgs.indexOf(first) + 1).find((m) => m.role !== 'user') : null;
  const recent = [];
  let used = 0;
  for (let i = tailMsgs.length - 1; i >= 0 && used < budget * 0.7; i--) {
    const t = `${tailMsgs[i].role === 'user' ? 'USER' : 'AGENT'}: ${tailMsgs[i].text.slice(0, 600)}`;
    recent.unshift(t);
    used += t.length;
  }
  return [first ? `FIRST ASK: ${first.text.slice(0, budget * 0.3)}` : '', reply ? `FIRST REPLY: ${reply.text.slice(0, 1500)}` : '',
    'RECENT:', ...recent].filter(Boolean).join('\n');
}

module.exports = { TEMP_CWD, isHuman, runs, walk, headTail, excerptFrom };
