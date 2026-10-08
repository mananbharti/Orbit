# Orbit landing page

This repository includes a static-exportable Next.js landing page at the project root. It is built with the App Router, TypeScript, and Tailwind CSS 4, with custom CSS for the responsive layout and product illustrations.

## Run locally

```bash
npm install
npm run dev
```

## Deploy

The project uses Next.js static export (`output: "export"`). Run `npm run build`; the deployable site is written to `out/`. Vercel can build the repository with the default Next.js settings.

Orbit is in early development. Phases 1–5 of the desktop service cover local pairing, its encrypted command channel, clipboard sync, file transfer, and app launching. Orbit Mobile is a later phase; input adapters are not wired to the service, and power/session controls are future work. The landing page labels its UI art as product direction and gives each roadmap feature a current status.

Download links point to the launch information panel, and notification links open GitHub's repository notification settings. There is no app download or separate email waitlist endpoint yet.
