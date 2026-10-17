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
3. Send a .pdf and a photo from the phone. On the PC they land in received\Documents and received\Images respectively. Send the same .pdf again: it arrives as "name (2).pdf" and the first copy is untouched.

Clipboard:
4. Copy text on the PC. Phone shows the incoming banner and it is already on the phone clipboard - paste anywhere.
5. While Orbit is open on the phone, copy text in another app. PC clipboard gets it (iOS may ask to allow pasting: Settings -> Apps -> Orbit -> Paste from Other Apps -> Allow).
6. Phone -> Clipboard -> History: tap an older entry. It lands on both clipboards.

Control:
7. Phone -> Control -> tap Lock. PC locks. Unlock, tap volume +/-. PC volume changes (watch the Windows volume HUD).
8. Play audio in two apps (e.g. Spotify + a browser video). APP VOLUME lists both; drag one down - only that app gets quieter. Mute one; unmute.
9. Panic Lock (bottom, red): confirm. PC locks AND the phone returns to the pair screen. Pairing is gone on both sides; pair again to continue.

Launcher:
10. Phone -> Apps: real icons stream in (8 at a time). Search "edge", tap it - Edge opens on the PC.
11a. Tap "+ New scene", name it "Work", tap 3 apps, Save. The Work chip appears. Tap it: all 3 apps open on the PC. Long-press the chip -> Edit, remove one app, Save. Long-press -> Delete.
11. Long-press Spotify -> Pin to top. A PINNED row appears above the grid. Long-press it again -> Move later. Close and reopen the app (and restart Orbit on the PC): the pinned row is still there, same order.

Wake-on-LAN (one-time PC setup first: Device Manager -> your network adapter -> Power Management -> allow this device to wake the computer; BIOS: enable Wake on LAN):
12. Pair, then sleep or shut down the PC (Control -> Sleep). Wait until the phone shows "Looking for your computer". Tap "Wake <PC name>". The PC powers on; the phone reconnects on its own within ~30s.

Remote:
13. Phone -> Remote: tap "Enable control". PC shows an in-app approval dialog (not a PowerShell box). Approve: move the trackpad, type.
14. MACROS: tap "+ Macro", name it "Paste plain", tap Ctrl + Shift, pick V, "Add step", Save. Open Notepad on the PC, copy formatted text from a browser, tap the Paste plain chip: plain text lands. Long-press the chip -> Delete. Restart the PC app: macros persist. tap "Enable control". PC shows an in-app approval dialog (not a PowerShell box). Approve: move the trackpad, type.

16. Gyro mouse: Remote -> start control -> tap Gyro. Hold the phone like a remote and tilt: the PC cursor follows. Small hand tremor should NOT move it. If it moves the wrong way, tell me which axis is inverted.
15. Present: open a PowerPoint deck on the PC. Phone home -> Present -> Start presenting (approve on PC). Tap "Start deck" (slideshow begins), > (next slide), Black screen, White screen, End deck. Touch-drag the laser pad: the red laser dot moves on screen.

Report anything that fails with the exact step number.
