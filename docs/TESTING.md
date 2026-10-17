# Real-device test plan (Windows 11 Omen + iPhone)

Setup (once per batch):

1. On the PC: `git clone https://github.com/mananbharti/Orbit.git && cd Orbit && git checkout v1.1`
2. `cd desktop && npm ci && npm run build`, then `npm start` (Electron control center opens)
3. Turn on the Windows mobile hotspot; join the iPhone to it
4. On the phone: `cd mobile/app && npm ci && npx expo start --dev-client`, open Orbit, pair with the QR shown by the desktop

## Batch 1 - shipped on v1.1 (October 17)

Files:
1. Phone -> Files -> send a PDF. PC shows a notification; Files tab lists it. Tap "Open" (opens it) and "Folder" (opens Explorer at the file).
2. Drag a file onto the PC window. Phone Files screen shows it arriving with progress.

Clipboard:
3. Copy text on the PC. Phone shows the incoming banner and it is already on the phone clipboard - paste anywhere.
4. While Orbit is open on the phone, copy text in another app. PC clipboard gets it (iOS may ask to allow pasting: Settings -> Apps -> Orbit -> Paste from Other Apps -> Allow).
5. Phone -> Clipboard -> History: tap an older entry. It lands on both clipboards.

Control:
6. Phone -> Control -> tap Lock. PC locks. Unlock, tap volume +/-. PC volume changes (watch the Windows volume HUD).
7. Play audio in two apps (e.g. Spotify + a browser video). APP VOLUME lists both; drag one down - only that app gets quieter. Mute one; unmute.
8. Panic Lock (bottom, red): confirm. PC locks AND the phone returns to the pair screen. Pairing is gone on both sides; pair again to continue.

Launcher:
9. Phone -> Apps: real icons stream in (8 at a time). Search "edge", tap it - Edge opens on the PC.

Remote:
10. Phone -> Remote: tap "Enable control". PC shows an in-app approval dialog (not a PowerShell box). Approve: move the trackpad, type.

Report anything that fails with the exact step number.
