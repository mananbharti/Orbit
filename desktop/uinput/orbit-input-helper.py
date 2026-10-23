#!/usr/bin/env python3
"""Orbit Wayland input helper: creates a virtual uinput device and applies JSON events from stdin.

Dependency-free (Python 3 standard library only). Requires write access to /dev/uinput,
which on most distros means a udev rule such as:
    KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
plus the user in the "input" group, then re-login or run: udevadm trigger

Protocol: one JSON object per line on stdin, fields:
  {"t":"move","dx":int,"dy":int}      relative pointer motion
  {"t":"button","button":"left|middle|right","action":"down|up|click"}
  {"t":"scroll","dx":int,"dy":int}    wheel units; dy>0 scrolls down, dx>0 scrolls right (Orbit convention)
  {"t":"key","codes":[int,...],"action":"down|up|click"}   evdev key codes, press order given, release reversed
  {"t":"stop"}                        exit
Lines that fail to parse are ignored; the helper never prints event content.

Self-test: run with ORBIT_INPUT_TEST_OUT=<path> and no /dev/uinput needed - the exact
event byte stream that would go to the kernel is written to that file instead.
"""
import fcntl
import json
import os
import struct
import sys

# ioctl constants (linux/uinput.h), valid on 32- and 64-bit because the _IOC size field matches here
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

EV_SYN, EV_KEY, EV_REL = 0x00, 0x01, 0x02
SYN_REPORT = 0
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL = 0x00, 0x01, 0x06, 0x08
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
SCROLL_UNITS_PER_NOTCH = 30  # matches the desktop adapters: 30 phone units ~ one wheel notch
MAX_NOTCHES = 10

EVENT = struct.Struct("llHHi")  # struct input_event on 64-bit: timeval(2 x long), __u16 type, __u16 code, __s32 value


def user_dev_struct(name: bytes) -> bytes:
    """struct uinput_user_dev: char name[80]; struct input_id{4 x __u16}; __u32 ff_effects_max;
    __s32 absmax[64]; absmin[64]; absfuzz[64]; absflat[64]."""
    name = name[:79].ljust(80, b"\0")
    input_id = struct.pack("HHHH", 0x03, 0x0F31, 0x0001, 0x0001)  # BUS_USB, Orbit vendor, product, version
    return name + input_id + struct.pack("I", 0) + (struct.pack("i", 0) * 64 * 4)


class VirtualInput:
    def __init__(self, test_out: str | None):
        self.test_file = open(test_out, "wb") if test_out else None
        self.fd: int | None = None
        if self.test_file:
            return
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        for bit in (EV_KEY, EV_REL):
            fcntl.ioctl(self.fd, UI_SET_EVBIT, bit)
        for code in (REL_X, REL_Y, REL_HWHEEL, REL_WHEEL):
            fcntl.ioctl(self.fd, UI_SET_RELBIT, code)
        # The kernel silently drops events whose code was never enabled, so advertise the full key range:
        # the phone's fixed key list, every modifier, and the mouse buttons all live below 0x2ff.
        for code in range(1, 0x2FF):
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, code)
        os.write(self.fd, user_dev_struct(b"Orbit Virtual Input"))
        fcntl.ioctl(self.fd, UI_DEV_CREATE)

    def emit(self, etype: int, code: int, value: int) -> None:
        data = EVENT.pack(0, 0, etype, code, value)
        if self.test_file:
            self.test_file.write(data)
        else:
            os.write(self.fd, data)  # type: ignore[arg-type]

    def sync(self) -> None:
        self.emit(EV_SYN, SYN_REPORT, 0)

    def close(self) -> None:
        if self.test_file:
            self.test_file.close()
            return
        if self.fd is not None:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY)
            except OSError:
                pass
            os.close(self.fd)


def notches(units: int) -> int:
    if not units:
        return 0
    return max(1, min(MAX_NOTCHES, round(abs(units) / SCROLL_UNITS_PER_NOTCH)))


def apply(dev: VirtualInput, event: dict) -> None:
    t = event.get("t")
    if t == "move":
        dx, dy = int(event.get("dx", 0)), int(event.get("dy", 0))
        if dx:
            dev.emit(EV_REL, REL_X, dx)
        if dy:
            dev.emit(EV_REL, REL_Y, dy)
        dev.sync()
    elif t == "button":
        code = {"left": BTN_LEFT, "right": BTN_RIGHT, "middle": BTN_MIDDLE}.get(event.get("button", "left"), BTN_LEFT)
        action = event.get("action", "click")
        if action in ("down", "click"):
            dev.emit(EV_KEY, code, 1)
        if action in ("up", "click"):
            dev.emit(EV_KEY, code, 0)
        dev.sync()
    elif t == "scroll":
        dy, dx = int(event.get("dy", 0)), int(event.get("dx", 0))
        if dy:  # dy > 0 scrolls down; REL_WHEEL is negative downward in evdev
            dev.emit(EV_REL, REL_WHEEL, -1 if dy > 0 else 1)
        if dx:  # dx > 0 scrolls right; REL_HWHEEL is positive rightward
            dev.emit(EV_REL, REL_HWHEEL, 1 if dx > 0 else -1)
        dev.sync()
    elif t == "key":
        codes = [int(c) for c in event.get("codes", [])]
        action = event.get("action", "click")
        if action in ("down", "click"):
            for c in codes:
                dev.emit(EV_KEY, c, 1)
        if action in ("up", "click"):
            for c in reversed(codes):
                dev.emit(EV_KEY, c, 0)
        dev.sync()


def main() -> None:
    dev = VirtualInput(os.environ.get("ORBIT_INPUT_TEST_OUT") or None)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if event.get("t") == "stop":
                break
            if event.get("t") == "scroll":  # expand units into notches, one event set per notch
                n = notches(int(event.get("dy", 0)) or int(event.get("dx", 0)))
                for _ in range(n):
                    apply(dev, event)
            else:
                apply(dev, event)
    finally:
        dev.close()


if __name__ == "__main__":
    main()
