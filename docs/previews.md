# Visual previews (no devices needed)

Both apps can render their screens in a plain browser with synthetic data, for design review and layout checks. Nothing here talks to a real PC or phone; treat every screenshot from these harnesses as a preview.

## Phone screens

```
cd mobile/app
npm run preview                          # every screen, light + dark
npm run preview -- remote-macros tasks   # only these screens
```

Output lands in `mobile/app/preview-shots/<screen>-<theme>.png` (gitignored). The screen list lives in `mobile/app/preview/Preview.tsx` (`SCREENS`) - add a case there and pass the new name to the script when a screen is added. Mock data is in `mobile/app/preview/mocks.ts`.

## Desktop shell tabs

```
cd desktop/shell/renderer
python3 -m http.server 8123
# open http://localhost:8123/index.html?tab=home
```

`?tab=` accepts `home`, `files`, `clipboard`, `devices`, `activity`, `settings`. The deep-link and the disabled entry animation only apply in this standalone mode; the packaged Electron app is unaffected.
