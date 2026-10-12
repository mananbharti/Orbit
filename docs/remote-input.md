# Remote mouse and keyboard

Status: protocol, session guard, phone API and screen are built and tested with a fake device. **No native input device exists yet**, so the feature is off by default. It cannot move a real pointer until a platform adapter and a confirmation prompt are supplied.

## Safety model
- One control session at a time. `input.begin` needs the desktop owner's confirmation (`BiometricConfirmation`); the default confirmation denies, so nothing starts without one.
- After that, every call needs the lease id, the same connection and a strictly increasing sequence number. A sequence is consumed before the device acts, so a failed or interrupted batch is never replayed.
- The phone sends a heartbeat. No heartbeat for 5 s, a closed connection or an expired session ends the lease and releases held buttons.
- Events are a closed set: pointer move, scroll (each at most 2000 per step), mouse buttons, a fixed list of keys, and printable text up to 64 characters. There is no raw key code, so the phone cannot press arbitrary shortcuts.
- Pairing scopes: the `input` scope must be granted to the phone (`ORBIT_PAIR_SCOPES`).
- Starts, ends and release failures are in the activity log.

## Still needed (desktop owner decisions)
1. A native `InputDevice` per OS (Windows SendInput, macOS CGEvent, Linux uinput/xdotool). These need a real machine to test.
2. A confirmation prompt on the desktop ("Allow <phone> to control this computer?") wired as `input.confirmation`.
3. First run on a real phone and computer.
