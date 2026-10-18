# Contributing to Orbit

First off, thanks for taking the time to contribute — Orbit is early-stage, and every issue, idea, and pull request genuinely helps shape it.

## Before You Start

Orbit is in active early development (see the [Roadmap](./README.md#roadmap)). Since core architecture decisions are still being made, **please open an issue to discuss any non-trivial change before submitting a pull request** — this avoids wasted work if the direction shifts.

Small fixes (typos, docs, obvious bugs) can go straight to a PR without a prior issue.

## How to Contribute

### Reporting Bugs

- Search existing issues first to avoid duplicates.
- Use the [bug report template](./.github/ISSUE_TEMPLATE) if available.
- Include: your OS (mobile + desktop), Orbit version/commit, steps to reproduce, and what you expected vs. what happened.

### Suggesting Features

- Check the [Roadmap](./README.md#roadmap) first — it may already be planned.
- Open a feature request issue describing the problem it solves, not just the feature itself. "Why" matters more than "what" at this stage.

### Submitting Code

1. Fork the repo and create a branch from `main`:
   ```bash
   git checkout -b feature/short-description
   ```
2. Make your changes. Keep commits focused — one logical change per commit.
3. Follow the existing code style in the file you're editing (mobile app: React Native/TypeScript conventions; desktop service: Node.js/TypeScript conventions).
4. Test your changes locally against both a mobile client and the desktop service where relevant.
5. Write a clear commit message and PR description: what changed, why, and how you tested it.
6. Open a pull request against `main` and link the related issue if one exists.

### Project Structure

```
orbit/
├── mobile/     # React Native app (iOS/Android)
├── desktop/    # Node.js background service + Electron app (Windows/Linux)
├── app/        # Landing site (Next.js)
├── extension/  # Browser extension for tab control (Chrome/Edge/Brave)
├── design/     # Logo, screenshots, architecture diagrams
└── docs/       # Additional documentation
```

## Code Guidelines

- **TypeScript** across both mobile and desktop where possible — type safety matters for a project handling input simulation and file transfer.
- **No secrets or credentials** committed, ever — use environment variables / local config for anything sensitive.
- **Security-sensitive changes** (pairing, encryption, permission scoping) need extra scrutiny — flag these clearly in your PR description and expect closer review.
- Keep platform-specific code isolated (don't let Windows-only or iOS-only logic leak into shared modules without a clear boundary).

## What We're Not Looking For

- Screen mirroring / remote-desktop viewing features — this is explicitly out of scope (see [What Orbit Is Not](./README.md#what-orbit-is-not)).
- Cloud-dependent features that break the local-first/no-cloud-round-trip principle without an opt-in flag.

## Questions?

Open an issue with the `question` label, or join the [Discord community](https://discord.gg/xQ3VaAnmPA).

---

By contributing, you agree that your contributions will be licensed under the project's [Apache License 2.0](./LICENSE).
