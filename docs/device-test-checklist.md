# Device test checklist

Everything in Orbit 1.0 was built and tested without a real phone or a real PC.
The automated tests (desktop, phone core, e2e) use fakes and loopback sockets.
This list is what a person has to run once to find out what actually works.
Tick each line, and open an issue for anything that fails.

## Setup

- [ ] `npm install` in `mobile/app` (the lock file is not committed).
- [ ] Start the desktop agent. Note the pairing code shown in the console.
- [ ] Start the Expo app on a phone on the same Wi-Fi.

## Pairing and security

- [ ] Pair with the code. The phone shows the PC name.
- [ ] A wrong code is refused.
- [ ] Run `devices` in the console, revoke the phone. The phone loses access at once.
- [ ] Re-pair after revoke works.
- [ ] Kill switch (Stop agent) stops a running task.

## Features (each should show up in the Activity log)

- [ ] Run an agent task, see progress, open its detail screen, retry it.
- [ ] Clipboard: send text both ways.
- [ ] Files: browse, download, upload one small file.
- [ ] Launcher: list apps and open one.
- [ ] Memory: add a fact, search for it.
- [ ] Remote input (needs `ORBIT_ENABLE_REMOTE_INPUT=1`): the PC dialog appears, Deny blocks, Yes allows.
- [ ] Dictation (needs whisper and ffmpeg, see `dictation.md`): record on iPhone and on Android, check the text.
- [ ] Hinglish dictation: note the accuracy honestly.

## Not built or not verified

- Native certificate pinning module has never been compiled.
- Windows SendInput script has only run against fake processes.
- Laya router has only run against a fake HTTP server.
- Hermes approve/deny body key is unverified.
- PC dictation hotkey is not built. It needs a native helper tested on Windows.
- No independent security review yet.

## Design review (never seen on a device)

The phone app was restyled in code only (themes, frosted glass surfaces, SVG icons, animations). Look at each screen in Auto, Light and Dark:

- [ ] Settings > Appearance switches Auto/Light/Dark at once and is remembered after a restart.
- [ ] The chips row and the message box look frosted on iPhone. On Android the blur may be weaker; check it still looks clean.
- [ ] Screens fade in smoothly. With Reduce Motion on, they appear with no animation.
- [ ] Nothing is clipped or overlapping on a small phone and on a large one.
- [ ] Every tap target feels comfortable to hit.
- Note: run `npm install` again in `mobile/app` (new packages: expo-blur, react-native-svg).
