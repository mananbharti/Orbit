# Packaging and release plan

Status: a plan written from the code. Nothing here has been built or signed. Each step lists what is known and what is not.

## Desktop (Windows, Linux, macOS)
Today the desktop service is a Node 24 program (`npm start`). Options to ship it, in order of effort:
1. **Run from source** with Node 24. Works now, fine for early testers.
2. **Node single executable** (`node --experimental-sea-config`) per OS. Unverified: the `ws`/TLS code and the native clipboard and launcher helpers have not been bundled this way.
3. **Installer** (MSI/MSIX on Windows, .deb/AppImage on Linux, signed .dmg on macOS) wrapping option 2, plus a login-item or service so Orbit starts at login.

Open items before any installer:
- Native input drivers (see `remote-input.md`) do not exist, so remote mouse and keyboard ship disabled.
- Dictation needs a bundled or downloaded whisper.cpp binary and a model file. Licenses of the chosen model must be checked before bundling.
- Code signing: Windows needs a code-signing certificate, macOS needs an Apple Developer ID and notarization. These cost money and need Manan's accounts.
- Auto-update is not designed. Without it, security fixes depend on users updating by hand.

## Phone (Android, iOS)
The app is Expo (SDK 54) with a custom native module for certificate pinning, so it needs a **development build**, not Expo Go:
1. `eas build --profile development --platform android` (and ios). The pinning module has never been compiled, so expect first-build fixes.
2. Android: a signed APK/AAB. Internal testing track first.
3. iOS: needs an Apple Developer account, a device registered for ad-hoc builds or TestFlight. The local-network permission string is already set.
4. Bundle ids are `app.orbit.mobile` on both. Change before publishing if Manan wants another.

Open items: app icons and splash assets, store listings, privacy labels (camera used only for the pairing QR, no data leaves the local network), the phone microphone module for dictation.

## Release checklist
- [ ] Desktop tests, phone core tests and e2e tests green in CI.
- [ ] First run on a real phone and a real computer, pairing through revoke.
- [ ] Independent security review of pairing, pinning and the input path.
- [ ] Threat model gaps in `threat-model.md` closed or accepted in writing.
- [ ] Licenses listed (Orbit is not yet licensed for others; third-party notices needed).
- [ ] Version numbers and changelog.

## Desktop app (added Oct 14)
`desktop/shell` is an Electron tray app around the same service: it picks the Wi-Fi address itself (`src/lan-address.ts`), advertises over mDNS, and shows a pairing QR, paired devices, activity and a start-at-login switch. Run it with `cd desktop && npm install && npm run app`. Installers: `npm run dist` (NSIS on Windows, AppImage and deb on Linux, dmg on macOS), or run the "Desktop installers" workflow. Builds are unsigned until signing certificates exist.
