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
