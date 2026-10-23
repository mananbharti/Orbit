# Real-device test plan (Windows 11 Omen + iPhone)

Setup (once per batch):

1. On the PC: `git clone https://github.com/mananbharti/Orbit.git && cd Orbit && git checkout v1.1`
2. `cd desktop && npm ci && npm run app` (builds, then opens the Orbit control-center window; `npm start` is the headless CLI instead)
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
8. Control -> THEME: tap Dark. Windows apps and the taskbar switch to dark within a second; tap Light to switch back. On a desktop monitor without a backlight the BRIGHTNESS row stays hidden - expected.
9. Play audio in two apps (e.g. Spotify + a browser video). APP VOLUME lists both; drag one down - only that app gets quieter. Mute one; unmute.
10. Panic Lock (bottom, red): confirm. PC locks AND the phone returns to the pair screen. Pairing is gone on both sides; pair again to continue.

Launcher:
11. Phone -> Apps: real icons stream in (8 at a time). Search "edge", tap it - Edge opens on the PC.
12. Tap "+ New scene", name it "Work", tap 3 apps, Save. The Work chip appears. Tap it: all 3 apps open on the PC. Long-press the chip -> Edit, remove one app, Save. Long-press -> Delete.
13. Long-press Spotify -> Pin to top. A PINNED row appears above the grid. Long-press it again -> Move later. Close and reopen the app (and restart Orbit on the PC): the pinned row is still there, same order.

Wake-on-LAN (one-time PC setup first: Device Manager -> your network adapter -> Power Management -> allow this device to wake the computer; BIOS: enable Wake on LAN):
14. Pair, then sleep or shut down the PC (Control -> Sleep). Wait until the phone shows "Looking for your computer". Tap "Wake <PC name>". The PC powers on; the phone reconnects on its own within ~30s.

Remote:
15. Phone -> Remote: tap "Enable control". PC shows an in-app approval dialog (not a PowerShell box). Approve: move the trackpad, type.
16. MACROS: tap "+ Macro", name it "Paste plain", tap Ctrl + Shift, pick V, "Add step", Save. Open Notepad on the PC, copy formatted text from a browser, tap the Paste plain chip: plain text lands. Long-press the chip -> Delete. Restart the PC app: macros persist.

17. App lock: kill the phone app, reopen it - Face ID is asked before it connects. Cancel the prompt: the app sits on a locked screen, no connection. Tap Unlock. Settings -> Require Face ID off, reopen: connects straight away. Turn it back on.
18. Gyro mouse: Remote -> start control -> tap Gyro. Hold the phone like a remote and tilt: the PC cursor follows. Small hand tremor should NOT move it. If it moves the wrong way, tell me which axis is inverted.
19. Present: open a PowerPoint deck on the PC. Phone home -> Present -> Start presenting (approve on PC). Tap "Start deck" (slideshow begins), > (next slide), Black screen, White screen, End deck. Touch-drag the laser pad: the red laser dot moves on screen.

20. Devices: Settings -> Devices. "This iPhone" shows Full access. If you have only one paired device, the Other devices card says none are paired. (With a second device paired: tap it -> turn Full access off -> switch off Apps; on that device the Apps tab now shows a permission error. Switch it back on.)

21. Computers (needs two PCs, or one PC + the preview): Settings -> Computers shows every paired computer with a check on the active one. Pair a second PC (Add a computer). Tap the other computer: Face ID, "Switching...", then the Home header shows its name. Tap the name on Home: the Computers screen opens. Forget the inactive one: tap Forget, then "Tap again to forget": it leaves the list. Forget the active one: you land on the Computers list (or the pair screen if none are left). Kill and reopen the app: it connects to the last active computer.

22. Automations: Home -> Automations -> New automation. Pick Sleep, set the time two minutes from now, leave Weekdays (or Every day), Save. Watch the PC sleep at that minute. Turn the switch off, delete the automation. Make one for Open Work scene at a near time: the scene's apps open on their own. Restart the PC app after one fires: it does not fire again.

23. Terminal: Home -> Terminal -> Start session. The PC shows an approval dialog - approve it. Run: dir (or ls). Output streams in. Run: cd Documents - the path above the output moves. Run: cd nowhere - an error line appears and the path does NOT move. Run: ping localhost -n 20 (Windows) or ping localhost (Mac/Linux), then tap the stop square: it dies within a second. Tap End session, then Start session and choose Deny on the PC: the phone says it was declined, no session opens.

24. Photo backup: Files -> turn on "Back up new photos", allow photo access. The first run uploads your whole library (takes a while; progress shows under the toggle). Check received/Images on the PC: photos arrive full size. Take a new photo and keep Orbit open about a minute: it appears in received/Images. Take another photo with Orbit closed, then open Orbit: it backs up on its own within a minute.

25. Share into Orbit (needs a dev-client rebuild first): in Photos or Files, share any file and choose Orbit in "Open in...". Orbit opens, the banner says it is sending the shared file, and it lands in received/<Type> on the PC. With Orbit killed, share again, then open Orbit and connect: the queued file sends on its own.
26. Share into Orbit on Android (needs the native-build APK on an Android phone): in Photos or Files, share a file and choose Orbit in the share sheet. Orbit opens, the banner says it is sending the shared file, and it lands in received/<Type> on the PC. Share a plain link or text instead: it lands on the PC clipboard. With Orbit killed, share again, then open Orbit and connect: the queued share sends on its own.

27. Browser tabs (needs the desktop app updated): on the PC, open chrome://extensions, turn on Developer mode, Load unpacked -> pick the orbit repo's extension folder. The extension's setup page asks for the port and token shown in Orbit's Settings on the PC. Phone Home -> Tabs: your PC browser's tabs appear. Tap one: that tab comes to the front on the PC. Close one from the phone. Type a link (e.g. wikipedia.org) and Open: it opens on the PC.

28. Place scenes: Apps -> long-press a scene -> "When I arrive here" (allow location). The scene chip gets an "arrives" marker. Leave the area with Orbit open, come back: within about a minute of arriving, the phone says it opened the scene and those apps launch on the PC. Long-press again -> "Remove place trigger" turns it off. (Works while Orbit is open; iOS does not let apps watch location in the background.)

29. Full keyboard: Remote -> start control -> "Full keyboard". Tap Q, W, a couple of letters: they type on the PC. Tap Ctrl then A: it selects all (modifier applies to the next key only, then clears). Tap F5: the focused app refreshes. Digits row types numbers. "Hide keyboard" folds it away.

30. Forget a device: Settings -> Devices -> tap another device -> "Forget this device" -> Forget. It disappears from the list and from the computer's Orbit window; that device can no longer connect without a fresh pairing code. "Unpair this iPhone" on the top card unpairs this phone and returns Orbit to the pair screen.

31. Agent tasks (needs a Hermes gateway on the PC): set up Hermes per docs/hermes.md, then Orbit Settings -> Agent tasks -> paste the API key -> Save; the dot goes green. On the phone, Home -> Tasks: ask "what is in my Downloads folder". Watch the task run with live steps; when it asks approval for something, Approve on the phone and it continues. Stop agent from the Tasks screen stops everything and new submits are refused while stopped. Settings -> Agent tasks -> Remove disconnects it again.
35. Control -> MEDIA: start music or a video on the PC (Spotify, YouTube in a browser - anything playing). Tap play/pause on the phone: playback pauses; tap again: it resumes. Tap next: the next track/episode starts. Tap previous: it goes back. These work without enabling Remote control - no approval dialog appears. On a PC with no media app running, taps are accepted quietly (the OS key goes nowhere harmful).
Report anything that fails with the exact step number.
## Batch 2 - features added since v1.1

Agent answer-only (needs the agent set up, step 31):
32. Home -> Tasks: tap "Answer only" above the composer (the chip expands to say what it means: a text reply from this computer, no actions). Ask a plain question. A text answer comes back and nothing runs - no steps, no approvals, nothing changes on the PC. Send: the chip turns itself off after the reply. Ask for an actual task with the chip off: it runs normally with steps as before. If the model is unreachable, the answer fails with a visible error - it must not silently fall back to running a task.

Private clipboard copies (Windows):
33. In your password manager, enable its clipboard-exclusion/privacy option if it has one (KeePass: clipboard exclusion; recent Bitwarden desktop versions mark copies automatically). Copy a password from it. The password must NOT appear on the phone clipboard, in Orbit's Clipboard History, or anywhere on the phone. Now copy ordinary text in any app: it still syncs as usual. Then send text phone -> PC: it applies immediately, no "conflict" message. If your password manager has no marking option, its copies are not marked and WILL sync - that is the documented boundary (only copies an app marks private are excluded), not a failure. Tell me which manager you used and whether it offers the option.

Wayland remote input (needs a Linux PC running a Wayland session - NOT the Omen):
34. One-time setup on that PC: pick one rule from docs/remote-input.md ("Wayland setup") - the uaccess tag rule is recommended; do not use the distro "input" group. Re-login, then run Orbit. Phone -> Remote -> "Enable control": the in-app approval dialog shows on the Linux PC. Approve: move the trackpad, click, two-finger scroll a long page (wheel must work, both directions). Tap letters on the full keyboard: they type. Free-text typing ("Type to send keystrokes") needs ydotool installed - without it, that one action reports unavailable while the rest keeps working. Stop control: held keys release (nothing stays stuck).
35. Control -> MEDIA: start music or a video on the PC (Spotify, YouTube in a browser - anything playing). Tap play/pause on the phone: playback pauses; tap again: it resumes. Tap next: the next track/episode starts. Tap previous: it goes back. These work without enabling Remote control - no approval dialog appears. On a PC with no media app running, taps are accepted quietly (the OS key goes nowhere harmful).
Report anything that fails with the exact step number.
