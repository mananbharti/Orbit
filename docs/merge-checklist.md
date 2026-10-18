# Merging v1.1 to main

Run these in order when Manan is happy with the real-device pass. Nothing here is urgent before then; v1.1 is fully self-contained.

## Before merging
- [ ] Complete the 29-step pass in [TESTING.md](TESTING.md) on the Omen + iPhone and flip each Real-device column in [ACCEPTANCE.md](ACCEPTANCE.md) from Pending to Verified (or note the issue found).
- [ ] Review the Vercel preview for v1.1 - the rewritten landing copy goes live on heyorbit.xyz the moment main updates.

## Merge
- [ ] Merge `v1.1` into `main` (PR or direct; ci.yml runs on every push, desktop-ci.yml and mobile-ci.yml run on main).
- [ ] Confirm CI is green on the merge commit.

## After merging
- [ ] README CI badge: change `?branch=v1.1` to `?branch=main` (it tracks v1.1 today).
- [ ] native-build.yml triggers on v1.1 pushes only; add `main` to its branch list (or keep building from a release branch) so phone artifacts stay current.
- [ ] Tag the release if wanted (e.g. `v1.1.0`). The phone app still reports version 0.1.0 in `mobile/app/app.json`; bump it before any store submission (Manan's call what the public version should be).

## Repo cleanup - DONE (Oct 18)
- [x] The original `Orbit-1.0` repository is deleted (Manan confirmed Oct 18, then removed it). Before deletion: its only branch was bit-identical to this repo's `main`, and its only tag (`v0.1.0-rc1`) was ported to this repo. Nothing was lost.
