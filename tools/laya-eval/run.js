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
 * Usage: node run.js [model] [baseUrl]     (defaults: laya, http://127.0.0.1:8000)
 *
 * Needs a running laya-server (https://github.com/nvkudva/laya-server):
 *   ./start.sh serve laya-multilingual --port 8000
 * The English "laya" checkpoint loads in fp32 on CPU and needs well over 2 GB
 * of free memory; laya-multilingual fits in ~1.5 GB.
 */
const http = require('http');
const path = require('path');
const corpus = require(path.join(__dirname, 'corpus.json'));
const MODEL = process.argv[2] || 'laya';
const BASE = new URL(process.argv[3] || 'http://127.0.0.1:8000');
if (BASE.hostname !== '127.0.0.1' && BASE.hostname !== 'localhost') {
  console.error('loopback only'); process.exit(2);
}
const QUESTIONS = {
  action: { instructions: "Does fulfilling this request require taking an action on the computer or another system - opening, changing, sending, booking, playing, deleting things, or reading local files or system state - rather than only answering with information the assistant already knows?", criteria: { yes: "fulfilling it requires an action or access to local files or system state", no: "it can be fulfilled with an informational text answer alone" } },
  current: { instructions: "Does answering this request correctly require information that changes over time, such as weather, prices, scores, schedules, availability, delays, versions, or news?", criteria: { yes: "correct answer needs current or live data", no: "stable knowledge suffices" } },
  intent: { instructions: "Is this request mainly asking for information, or asking for a task to be carried out?", criteria: { information: "mainly wants information or content", task: "mainly wants something done" } }
};
function ask(state) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ state, model: MODEL, questions: Object.fromEntries(
      Object.entries(QUESTIONS).map(([n, q]) => [n, { type: 'choice', instructions: q.instructions, criteria: q.criteria }])) });
    const req = http.request({ host: BASE.hostname, port: BASE.port, path: '/v1/systemone', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json: ' + data.slice(0, 200))); } });
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('timeout'))); req.end(body);
  });
}
(async () => {
  const rows = [];
  for (const item of corpus) {
    const res = await ask(item.prompt);
    const ans = res.answers || {};
    const row = { id: item.id, cls: item.cls };
    for (const name of Object.keys(QUESTIONS)) {
      const a = ans[name];
      if (!a) { row[name] = 'MISSING'; row[name + '_p'] = 0; continue; }
      row[name] = a.choice;
      row[name + '_p'] = +(a.answer_confidence ?? (a.probabilities && a.probabilities[a.choice]) ?? 0).toFixed(3);
    }
    rows.push(row);
  }
  const safeCount = corpus.filter(c => c.cls === 'static').length;
  const strategies = {
    S1_actionOnly: r => r.action === 'no',
    S2_intent: r => r.intent === 'information',
    S3_actionAndCurrent: r => r.action === 'no' && r.current === 'no',
    S4_unanimous: r => r.action === 'no' && r.current === 'no' && r.intent === 'information',
    S5_S3conf60: r => r.action === 'no' && r.current === 'no' && r.action_p >= 0.6 && r.current_p >= 0.6,
    S6_S3conf80: r => r.action === 'no' && r.current === 'no' && r.action_p >= 0.8 && r.current_p >= 0.8,
  };
  console.log('MODEL=' + MODEL + ' prompts=' + rows.length);
  for (const [name, gate] of Object.entries(strategies)) {
    let miss = 0, missIds = [], held = 0, heldTotal = 0;
    for (let i = 0; i < corpus.length; i++) {
      const allow = gate(rows[i]); const safe = corpus[i].cls === 'static';
      if (!safe) { heldTotal++; if (allow) { miss++; missIds.push(corpus[i].id); } }
      else if (allow) held++;
    }
    console.log(name + ': dangerous-misses=' + miss + '/' + heldTotal + (missIds.length ? ' [' + missIds.join(',') + ']' : '') +
      '  safe-allowed=' + held + '/' + safeCount);
  }
  console.log('--- raw rows ---');
  for (let i = 0; i < corpus.length; i++)
    console.log(rows[i].id, corpus[i].cls, 'action=' + rows[i].action + '@' + rows[i].action_p,
      'current=' + rows[i].current + '@' + rows[i].current_p, 'intent=' + rows[i].intent + '@' + rows[i].intent_p);
})().catch(e => { console.error('EVAL FAILED:', e.message); process.exit(1); });
