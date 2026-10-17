# Getting started

The short path for a real install is [BUILD-CHECKLIST.md](BUILD-CHECKLIST.md) (desktop window, iPhone dev-client rebuild, pairing, browser extension, test pass). This page covers the same ground with more detail, plus the headless/CLI options.

## What you need
- Node 24 on the computer.
- A phone with the Orbit app (Expo build, see `mobile/app`). Phone and computer on the same network.
- Optional: a Hermes agent server for the agent features (see `hermes.md`).

## Run the desktop side
The normal way is the Orbit window:
```
cd desktop
npm ci
npm run app         # builds and opens the Orbit app (pairing code, activity, settings)
```
Headless (servers, SSH) also works: `npm start` runs the service without the window.
Settings are environment variables:

| Variable | Meaning |
| --- | --- |
| ORBIT_DATA_DIR | where Orbit keeps its private files |
| ORBIT_PORT, ORBIT_HOST | listen address |
| ORBIT_DISPLAY_NAME | name shown on the phone |
| ORBIT_PAIR_SCOPES | what a newly paired phone may do: agent, clipboard, files, launcher, input, dictation. Default is full access, so narrow it. |
| ORBIT_HERMES_URL, ORBIT_HERMES_API_KEY | turn on agent tasks |
| ORBIT_RECEIVE_DIR | where received files land |
| ORBIT_TLS_CERT, ORBIT_TLS_KEY | use your own certificate |

## Pair a phone
1. In the Orbit window, choose "Show pairing code" (the headless service prints a QR instead).
2. Open the phone app, choose Pair, scan the QR.
3. The phone pins the computer's certificate. Later connections to anything else are refused. Codes work once and expire after two minutes.

## Managing devices
- The phone manages itself and others: Settings -> Devices for permissions, "Forget this device", and "Unpair this iPhone".
- The Orbit window lists paired devices too and can revoke any of them.
- Headless: `devices` lists paired phones, `revoke <id>` removes one immediately.

## Stop everything
The phone has a "Stop agent" button (safe mode). It survives a restart and is written to the activity log.

## Export the audit trail
```
npm run audit:export -- <data-dir> csv
```

## Known limits
See `threat-model.md`, `remote-input.md` and `dictation.md`. Short version: remote mouse and keyboard have no native driver yet, dictation has no real model tested, and there is no independent security review.

## Remote mouse and keyboard (Windows, experimental)
Off by default. Set `ORBIT_ENABLE_REMOTE_INPUT=1` before `npm start`. Each time the phone starts a control session, a dialog appears on the PC asking to allow it (default is No, times out as No after 30 seconds). Written but never run on a real Windows PC: expect to debug it. See `remote-input.md`.
