# Remote mouse and keyboard

Status: protocol, session guard, phone API and screen are built and tested with a fake device. A Windows native device (SendInput in one PowerShell worker) is implemented and wired in both entrypoints - the CLI behind `ORBIT_ENABLE_REMOTE_INPUT=1`, the Electron app with an approval dialog. It has not run on real hardware yet, so the feature stays off by default.

## Safety model
- One control session at a time. `input.begin` needs the desktop owner's confirmation (`BiometricConfirmation`); the default confirmation denies, so nothing starts without one.
- After that, every call needs the lease id, the same connection and a strictly increasing sequence number. A sequence is consumed before the device acts, so a failed or interrupted batch is never replayed.
- The phone sends a heartbeat. No heartbeat for 5 s, a closed connection or an expired session ends the lease and releases held buttons.
- Events are a closed set: pointer move, scroll (each at most 2000 per step), mouse buttons, a fixed list of keys, and printable text up to 64 characters. There is no raw key code, so the phone cannot press arbitrary shortcuts.
- Pairing scopes: the `input` scope must be granted to the phone (`ORBIT_PAIR_SCOPES`).
- Starts, ends and release failures are in the activity log.

## Still needed
1. First run of the Windows driver and the approval prompt on a real PC and phone.
2. Linux and macOS `InputDevice` adapters (uinput/xdotool, CGEvent) - future work; both entrypoints gate remote input to Windows today.
