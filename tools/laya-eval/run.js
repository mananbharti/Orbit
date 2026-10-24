#!/usr/bin/env node
/*
 * Laya answer-only eligibility evaluation.
 *
 * Measures whether a Laya checkpoint can separate prompts that are safe for a
 * local answer-only reply (stable knowledge, conversation) from prompts that
 * must reach the agent (actions on the computer, local data, current data).
 * The dangerous direction is routing a do-something request to a text-only
 * answer; the costly direction is routing easy questions to the agent anyway.
 *
 * Usage: node run.js [model] [baseUrl] [timeoutSeconds]
 *   (defaults: laya, http://127.0.0.1:8000, 60)
 *
 * Needs a running laya-server (https://github.com/nvkudva/laya-server):
 *   ./start.sh serve laya-multilingual --port 8000
 *
 * One curl per prompt with a hard timeout, rows flushed to rows-<model>.jsonl
 * next to this script; an interrupted run resumes where it stopped. (A
 * long-lived keep-alive client stalled mid-corpus against a slow server;
 * per-request processes do not.) Analysis runs at the end from the same file.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const corpus = require(path.join(__dirname, 'corpus.json'));
const MODEL = process.argv[2] || 'laya';
const BASE = new URL(process.argv[3] || 'http://127.0.0.1:8000');
const TIMEOUT = Math.max(5, Number(process.argv[4]) || 60);
if (BASE.hostname !== '127.0.0.1' && BASE.hostname !== 'localhost') {
  console.error('loopback only'); process.exit(2);
}
const ROWS = path.join(__dirname, `rows-${MODEL}.jsonl`);
const QUESTIONS = {
  action: { instructions: "Does fulfilling this request require taking an action on the computer or another system - opening, changing, sending, booking, playing, deleting things, or reading local files or system state - rather than only answering with information the assistant already knows?", criteria: { yes: "fulfilling it requires an action or access to local files or system state", no: "it can be fulfilled with an informational text answer alone" } },
  current: { instructions: "Does answering this request correctly require information that changes over time, such as weather, prices, scores, schedules, availability, delays, versions, or news?", criteria: { yes: "correct answer needs current or live data", no: "stable knowledge suffices" } },
  intent: { instructions: "Is this request mainly asking for information, or asking for a task to be carried out?", criteria: { information: "mainly wants information or content", task: "mainly wants something done" } }
};
function body(state) {
  return JSON.stringify({ state, model: MODEL, questions: Object.fromEntries(
    Object.entries(QUESTIONS).map(([n, q]) => [n, { type: 'choice', instructions: q.instructions, criteria: q.criteria }])) });
}
function ask(state) {
  const res = spawnSync('curl', ['-s', '-m', String(TIMEOUT), '-X', 'POST', `${BASE.origin}/v1/systemone`,
    '-H', 'content-type: application/json', '-d', body(state)], { input: '', encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) return { error: 'timeout_or_empty' };
  try { return JSON.parse(res.stdout); } catch { return { error: 'bad_json' }; }
}
const done = new Set();
if (fs.existsSync(ROWS)) for (const line of fs.readFileSync(ROWS, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { const r = JSON.parse(line); if (!r.resp || !r.resp.error) done.add(r.id); } catch { /* partial line */ }
}
let ran = 0;
for (const item of corpus) {
  if (done.has(item.id)) continue;
  const resp = ask(item.prompt);
  fs.appendFileSync(ROWS, JSON.stringify({ id: item.id, cls: item.cls, resp }) + '\n');
  ran++;
  if (resp.error) console.error(`warn: ${item.id} -> ${resp.error}`);
}
const rows = fs.readFileSync(ROWS, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const parsed = corpus.map(item => {
  const row = rows.find(r => r.id === item.id) || { resp: {} };
  const out = { id: item.id, cls: item.cls };
  const ans = row.resp.answers || {};
  for (const n of Object.keys(QUESTIONS)) {
    const a = ans[n];
    out[n] = a ? a.choice : 'MISSING';
    out[n + '_p'] = a ? +((a.answer_confidence ?? (a.probabilities && a.probabilities[a.choice]) ?? 0).toFixed(3)) : 0;
  }
  return out;
});
const missing = parsed.filter(r => Object.keys(QUESTIONS).some(n => r[n] === 'MISSING'));
const strategies = {
  S1_actionOnly: r => r.action === 'no',
  S2_intent: r => r.intent === 'information',
  S3_actionAndCurrent: r => r.action === 'no' && r.current === 'no',
  S4_unanimous: r => r.action === 'no' && r.current === 'no' && r.intent === 'information',
  S5_S3conf60: r => r.action === 'no' && r.current === 'no' && r.action_p >= 0.6 && r.current_p >= 0.6,
  S6_S3conf80: r => r.action === 'no' && r.current === 'no' && r.action_p >= 0.8 && r.current_p >= 0.8,
};
console.log(`MODEL=${MODEL} prompts=${parsed.length} fetched_this_run=${ran}` + (missing.length ? ' MISSING:' + missing.map(m => m.id).join(',') : ''));
for (const [name, gate] of Object.entries(strategies)) {
  let miss = 0, missIds = [], held = 0, heldTotal = 0;
  for (const r of parsed) {
    const allow = gate(r); const safe = r.cls === 'static';
    if (!safe) { heldTotal++; if (allow) { miss++; missIds.push(r.id); } }
    else if (allow) held++;
  }
  console.log(name + ': dangerous-misses=' + miss + '/' + heldTotal + (missIds.length ? ' [' + missIds.join(',') + ']' : '') +
    '  safe-allowed=' + held + '/' + parsed.filter(c => c.cls === 'static').length);
}
console.log('--- raw rows ---');
for (const r of parsed)
  console.log(r.id, r.cls, 'action=' + r.action + '@' + r.action_p,
    'current=' + r.current + '@' + r.current_p, 'intent=' + r.intent + '@' + r.intent_p);
