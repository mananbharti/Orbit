# Laya answer-only eligibility evaluation

Could Orbit let a fast local model decide which requests get a text-only answer
and which go to the agent? This tool measures that separation on a real
laya-server checkpoint. Answer-only in Orbit is explicit per request instead;
this corpus and runner exist so the decision can be revisited with numbers.

- `corpus.json` - 46 labeled prompts: `action` (must reach the agent, including
  mixed and adversarial cases), `current` (needs live data), `static` (safe for
  a local text answer).
- `run.js` - asks three choice questions per prompt in one `POST /v1/systemone`
  call (action required? current data required? information or task?) and
  reports six gating strategies. For each: dangerous misses (action/current
  prompts a strategy would have answered text-only) and safe-allowed (static
  prompts it would still answer locally).

```sh
# in a checkout of https://github.com/nvkudva/laya-server
./start.sh serve laya-multilingual --port 8000
# here
node tools/laya-eval/run.js laya-multilingual
```

Loopback only. The English `laya` checkpoint loads in fp32 on CPU and needs
well over 2 GB of free memory (a 2 GB environment OOM-kills it); the
multilingual checkpoint fits in about 1.5 GB.

Results are kept in [docs/laya.md](../../docs/laya.md).
