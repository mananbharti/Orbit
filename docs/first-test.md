# First test, step by step

Written for a first-timer with a Windows PC and an iPhone with a free Apple ID (no paid developer account).
QR pairing and the encrypted session are proven on a real Windows 11 PC and iPhone (October 14, over a Windows hotspot). The rest is waiting on the device pass in `docs/TESTING.md`. If a step fails, send the exact error text.

## Why this is not just "open Expo Go"
Orbit pins the computer's certificate so nobody on the Wi-Fi can pretend to be your PC. Expo Go cannot do that, so Orbit needs its own phone app. There is deliberately no "skip security" switch.

## Part 1: start the desktop side (Windows)
1. Install Node 24 from nodejs.org and Git.
2. In PowerShell:
   ```
   git clone https://github.com/mananbharti/Orbit.git
   cd Orbit
   git checkout v1.1
   cd desktop
   npm ci
   npm test
   ```
   Tests should end with `fail 0`.
3. Hostel and many other Wi-Fi networks block device-to-device traffic. The reliable setup: turn on the Windows Mobile Hotspot (Settings -> Network & Internet -> Mobile hotspot) and join the iPhone to it. The PC's address on the hotspot is then `192.168.137.1`. If you use a normal Wi-Fi instead, find the PC's address with `ipconfig` ("IPv4 Address", looks like 192.168.1.23).
4. Start it, using that address:
   ```
   $env:ORBIT_HOST="192.168.137.1"
   $env:ORBIT_DATA_DIR="$HOME\orbit-data"
   npm run app
   ```
   Allow it in the Windows Firewall popup (private networks). `npm run app` builds and opens the Orbit window; for a headless run use `npm start` instead.
5. Agent tasks only work with a Hermes server. For the first test you can skip this. If you have one, also set `$env:ORBIT_HERMES_URL` and `$env:ORBIT_HERMES_API_KEY` before `npm start`. Do not paste the key anywhere else.
6. In the Orbit window press "Show pairing code" to get a two-minute QR. (Headless CLI instead: `npm start`, then type `pair` and press Enter - it writes `pairing.svg` and `pairing.json` in `%USERPROFILE%\orbit-data`; open pairing.svg in a browser.)

## Part 2a: iPhone with a free Apple ID (sideload)
1. On GitHub open https://github.com/mananbharti/Orbit/actions , choose "native-build", open the latest run **on branch v1.1** (older runs built the pre-v1.1 app and are missing most features), download the artifact `orbit-ios-unsigned-ipa`, unzip it to get `Orbit-unsigned.ipa`. (If the iOS job failed, stop and send me the error.)
2. On the PC install iTunes and iCloud from apple.com (not the Microsoft Store versions), then Sideloadly from sideloadly.io.
3. Plug the iPhone in with a cable, tap Trust. In Settings > Privacy & Security turn on Developer Mode and restart the phone.
4. In Sideloadly pick the iPhone, drag in the ipa, enter your Apple ID, press Start.
5. On the phone: Settings > General > VPN & Device Management > your Apple ID > Trust.
6. Free Apple IDs expire the app after 7 days: just repeat steps 4 and 5. Limit: 3 sideloaded apps at a time.
7. Open Orbit on the phone, on the same Wi-Fi as the PC, and scan the QR from step 6 above.
Unknown: Sideloadly support for the newest iOS version on an iPhone 17 Pro was not checked. If it refuses, use Part 2b to test everything except iPhone-specific parts.

## Part 2b: Android emulator on the PC (fallback, no phone needed)
1. Install Android Studio. In Device Manager create a phone (Pixel, latest Android) and start it.
2. Download the artifact `orbit-android-apk` from the same Actions page, unzip, drag `app-release.apk` onto the emulator window.
3. The emulator has no usable camera for QR. In the Orbit app use "Paste the code": open `%USERPROFILE%\orbit-data\pairing.json`, copy everything, paste into the app, press Pair. Keep ORBIT_HOST as the PC's Wi-Fi address.
Microphone dictation and haptics are not meaningful on an emulator.

## What to check
Go through `docs/TESTING.md` (29 steps) after `docs/BUILD-CHECKLIST.md`. Send me: what worked, and for anything that failed the exact step number and the message on screen.
