# Merging v1.1 to main - MERGED Oct 19

Manan ordered the merge on Oct 19 ("Merge kar do") ahead of the real-device pass so the contribution graph counts the v1.1 work. v1.1 was merged into main at 2:12 AM as a fast-forward to `41bff9d`; all 11 CI checks on the merge commit are green, including the iOS/Android native builds. The real-device pass below is still outstanding and remains the gate for calling v1.1 device-verified.

## Still outstanding
- [ ] Complete the 30-step pass in [TESTING.md](TESTING.md) on the Omen + iPhone and flip each Real-device column in [ACCEPTANCE.md](ACCEPTANCE.md) from Pending to Verified (or note the issue found).
- [ ] Tag the release if wanted (e.g. `v1.1.0`). The phone app still reports version 0.1.0 in `mobile/app/app.json`; bump it before any store submission (Manan's call what the public version should be).

## Merge - DONE (Oct 19)
- [x] Merged `v1.1` into `main` (fast-forward, `41bff9d`).
- [x] Confirmed CI green on the merge commit (all 11 checks).

## After merging - DONE (Oct 19)
- [x] README CI badge now tracks `main`.
- [x] native-build.yml keeps triggering on v1.1 pushes (release-branch approach), so phone artifacts stay current as v1.1 advances.

## Repo cleanup - DONE (Oct 18)
- [x] The original `Orbit-1.0` repository is deleted (Manan confirmed Oct 18, then removed it). Before deletion: its only branch was bit-identical to this repo's `main`, and its only tag (`v0.1.0-rc1`) was ported to this repo. Nothing was lost.
