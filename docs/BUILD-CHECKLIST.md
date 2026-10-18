# Real-device build checklist

One pass, start to finish, to run everything on your Omen + iPhone. About 30 minutes, mostly waiting for builds.

## 1. Get the code
- `git clone https://github.com/mananbharti/orbit.git` (or pull), then `git checkout v1.1`.

## 2. Desktop app (Windows)
- `cd desktop && npm install && npm run app` - builds and opens the Orbit window.
- The window shows a status dot and "Show pairing code". Leave it running.
- If your phone will connect over the Windows hotspot: start the hotspot first, then launch Orbit with `$env:ORBIT_HOST="192.168.137.1"; npm run app` in PowerShell (hostel Wi-Fi blocks device-to-device traffic; the hotspot does not).

## 3. iPhone app
The app needs photo-backup, location, and share-receiving permissions, so Expo Go cannot run it. Pick one:
- No Mac (the usual route): sideload the current v1.1 `orbit-ios-unsigned-ipa` artifact with Sideloadly and a free Apple ID - the full steps are in [docs/first-test.md](first-test.md) Part 2a. The artifact already includes every permission.
- With a Mac: `cd mobile/app && npm install && npx expo run:ios --device`, then `npx expo start --dev-client`.
- If you installed a dev client from before v1.1, reinstall once - older builds lack these permissions.

## 4. Pair
- Phone: Pair, scan the code on the PC. Face ID confirms.
- Expect the PC to show approval dialogs the first time you use Remote control or Terminal. Approving is per session.

## 5. Browser extension (for tab control)
- Chrome or Edge: `chrome://extensions` -> Developer mode -> **Load unpacked** -> pick this repo's `extension/` folder.
- The extension's setup page asks for the port and token - Orbit's Settings on the PC shows both, with copy buttons. Badge turns green when connected.

## 6. Turn things on
- Files screen: turn on "Back up new photos" (allow photo access) - first run backs up the library, then only new photos.
- Apps screen: long-press a scene -> "When I arrive here" if you want place triggers (allow location).
- Home -> Automations: any schedules you want.

## 7. Test pass
- Walk docs/TESTING.md steps 1-29 in order. Report anything that fails with the exact step number.
- Foreground-only notes (platform limits, not bugs): clipboard sync, photo backup, and place triggers run while Orbit is open on the phone; each catches up on the next open.

## Design review without devices

See [docs/previews.md](previews.md) to render every phone screen and shell tab in a browser with sample data.

## If something breaks
- Desktop window -> Activity tab shows every command the phone sent and what happened.
- Phone: kill and reopen Orbit; it reconnects to the last computer on its own.
