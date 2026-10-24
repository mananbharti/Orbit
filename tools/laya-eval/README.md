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

Loopback only. The multilingual checkpoint fits in about 1.5 GB. The English
`laya` checkpoint wants ~4 GB free in stock form (fp32 container over fp16
weights); on a memory-tight box it can still run with a LOCAL, uncommitted
patch to the server venv - fp16 model container, per-tensor streamed weight
loading via safetensors safe_open, and two activation casts following weight
dtype (agent.py: build wrapped in torch.set_default_dtype(torch.float16);
common.py: AutoModel.from_config(..., dtype=torch.float16); common.py forward:
drop `.float()` on pooled, cast the concatenated head input to the head weight
dtype). Numbers produced that way must be labeled fp16-forced; prefer a bigger
machine over the patch. Note the sequential node client stalled mid-corpus
twice against the fp16 server while curl with a hard timeout did not - chunk
long runs with curl rather than trusting one long-lived process.

Results are kept in [docs/laya.md](../../docs/laya.md).
