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
- [ ] Tag the release if wanted (e.g. `v1.1.0`).

## Repo cleanup - needs Manan's explicit confirmation
- [ ] Delete the original `Orbit-1.0` repository. It is superseded by this one, but deletion is irreversible and its stars/issues/history should be noted first. Do not delete without a clear yes.
