# Fast layer: Laya task triage

Orbit's router sends a request to a fast local model first and to the Hermes agent for the deep work (see the README vision). The fast layer is [Laya](https://huggingface.co/convaiinnovations/laya), the local counterpart of TypeSafe's System One decision model, served by the Apache-2.0 [laya-server](https://github.com/nvkudva/laya-server). Laya only decides - it never writes text - so its first job in Orbit is triage: every new agent task gets a kind-of-work label (coding, research, files, communication, system, other) in its timeline, in about a second, before the Hermes agent starts the deep work.

## Setup

```sh
git clone https://github.com/nvkudva/laya-server.git
cd laya-server
./start.sh          # macOS / Linux; .\start.ps1 on Windows
```

That is all. While a Laya server answers on `http://127.0.0.1:8000`, Orbit picks it up automatically (the models list must actually name Laya, so an unrelated server on the port is never treated as a decision engine) and labels new tasks. No key, no account, nothing leaves the PC. Run the server on a different loopback port? Set it in Settings > Agent tasks (Decision model address), or with `ORBIT_LAYA_URL` for the CLI. Loopback only, by design: the settings field refuses non-local addresses and the client refuses them too. Without a server, tasks simply run untriaged - triage never blocks or fails a task.

The wire contract is the Jev/System One API (`POST /v1/systemone`, `model` + `state` + named typed questions), verified October 24, 2026 against the laya-server README, the api.typesafe.ai v0.2.0 reference, and a live local server classifying real Orbit task prompts.

## Answer-only tasks (optional)

With a local model server running - Ollama on :11434 or LM Studio on :1234 - Settings > Agent tasks > Detect models lists its installed models. Pick one, and the phone shows an answer-only choice on the Agent screen: the picked model writes a text answer on this computer, and that is all. The phone shows the choice because a model is picked - picked, not proven live: if the model is off when you ask, the task fails honestly and nothing else happens. You choose it per task on the phone, so intent never depends on a classifier; every normal task runs the agent as usual. An answer-only task never touches the agent, never takes actions, and says so in its timeline ("Answered locally - no actions taken"). If no model is picked or the model does not answer, the task fails honestly - it never falls back to the agent you opted out of.

Why not automatic fast routing? It was built, then measured twice against the real laya-multilingual server (October 24, 2026). The first six-prompt evaluation failed both directions: a single yes/no eligibility question passed "research current flight prices to Delhi and book the cheapest one" at 0.906 confidence while refusing plain static questions, and the action-detection question stayed confidently wrong on booking and messaging requests. A classifier that cannot tell "answer this" from "do this" must not decide which requests get done, so automatic diversion was removed before anyone could rely on it.

### Expanded evaluation: 46 prompts, three gates, six strategies

The second evaluation ([tools/laya-eval](../tools/laya-eval)) ran 46 labeled prompts (18 action including mixed and adversarial cases, 11 current-data, 17 safe static/conversational) against laya-multilingual, asking three choice questions per prompt in one forward pass - action required? current data required? information or task? - and scoring six gating strategies. A dangerous miss answers a do-something or live-data request with text only; safe-allowed is how much easy traffic a strategy still answers locally.

| Strategy (allow answer-only if) | Dangerous misses (of 32) | Safe allowed (of 14) |
| --- | --- | --- |
| action gate alone | 4 | 4 |
| intent = information | 12 | 4 |
| action + current gates | 0 | 4 |
| unanimous (all three) | 0 | 0 |
| action + current, confidence >= 0.6 | 0 | 2 |
| action + current, confidence >= 0.8 | 0 | 0 |

The measured tradeoff on this checkpoint, with this question set: the action gate over-fires on ordinary questions - "What can you do?" scores action=yes at 0.949 - while real actions score as low as 0.627 ("Cancel my dentist appointment on Friday", itself caught only by the current-data gate). The two distributions overlap, so no confidence threshold separated them here: the only zero-miss gating (action + current) let through 4 of 14 safe prompts, and every threshold above that let through fewer. An automatic router with these numbers would either miss dangerous requests or push most easy questions to the agent anyway. That is a measured result for laya-multilingual with three questions on 46 prompts - not a proof that no gating can work. Unmeasured axes: the English checkpoint (below), other question phrasings, a larger corpus, and per-prompt retries.

### English checkpoint, same corpus (fp16-forced, caveated)

The English `laya` checkpoint was OOM-killed in the 2 GB sandbox in stock form: the weights on disk are already fp16 (205 of 206 tensors), but the server builds an fp32 container from the encoder config, peaking near 2.4 GB. With a local, uncommitted patch (fp16 container + streamed weight loading + two activation casts; recipe in tools/laya-eval/README.md) the same eval ran end to end on the same 46 prompts, in fp16 numerics at ~15 s per prompt (no AMX on this CPU) - relative comparisons are informative, absolute confidences carry the fp16 caveat.

| Strategy (allow answer-only if) | Dangerous misses (of 32) | Safe allowed (of 14) |
| --- | --- | --- |
| action gate alone | 15 | 14 |
| intent = information | 17 | 12 |
| action + current gates | 10 | 14 |
| unanimous (all three) | 7 | 12 |
| action + current, confidence >= 0.6 | 7 | 13 |
| action + current, confidence >= 0.8 | 0 | 6 |

The profile is the opposite of multilingual's: this checkpoint rarely over-fires on plain questions (every static scored action=no), but it under-fires on real actions (10 of 22 action prompts read action=no, e.g. "Summarize the three PDFs in Downloads" at 0.766), and its current-data gate is weak (4 of 11 current-data prompts detected). The notable row is the last one: at confidence >= 0.8 on both gates it scored 0 dangerous misses while still answering 6 of 14 safe prompts - because when this checkpoint is wrong it is usually under-confident (wrong answers sat at 0.51-0.78), which is the calibration property a threshold gate needs. Multilingual had no such threshold (0 of 14 safe at the same safety level). 46 prompts and one phrasing family is not a safety proof, and fp16 numerics may shift borderline scores; but the tradeoff curve is measurable and moves the right way with the stronger checkpoint, so eligibility stays open with numbers rather than folklore.

On any machine with ~4 GB free RAM the stock server runs this checkpoint in fp32 - no patch, no fp16 caveat: `node tools/laya-eval/run.js laya`. The multilingual numbers above stand as measured; the English row stands as measured-under-fp16.

The decision-model client (decideMany) and the detection settings stay in the tree for when eligibility can be made reliable.
