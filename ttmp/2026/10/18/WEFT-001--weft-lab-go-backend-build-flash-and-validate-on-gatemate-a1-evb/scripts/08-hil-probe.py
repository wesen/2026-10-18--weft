#!/usr/bin/env python3
"""Talk to weft_hil on the board's UART: drain, send commands, print the lines that come back.

usage: 08-hil-probe.py [--dev /dev/ttyACM0] [--secs 1.2] CMD...   (e.g. R "I 2 2" T)
Each CMD is sent as one line; the script then reads for --secs and prints every line with its arrival time.
"""
import argparse, os, select, termios, time

ap = argparse.ArgumentParser()
ap.add_argument("--dev", default="/dev/ttyACM0")
ap.add_argument("--secs", type=float, default=1.2)
ap.add_argument("--gap", type=float, default=0.05, help="seconds between commands")
ap.add_argument("cmds", nargs="*")
a = ap.parse_args()

fd = os.open(a.dev, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
t = termios.tcgetattr(fd)
t[0] = 0; t[1] = 0; t[2] = termios.CS8 | termios.CREAD | termios.CLOCAL; t[3] = 0
t[4] = t[5] = termios.B115200
t[6][termios.VMIN] = 0; t[6][termios.VTIME] = 0
termios.tcsetattr(fd, termios.TCSANOW, t)
# drain what the bridge sent while nobody read
end = time.time() + 0.3
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.05)
    if r:
        try: os.read(fd, 4096)
        except BlockingIOError: pass
t0 = time.time()
buf = b""
def pump(until):
    global buf
    while time.time() < until:
        r, _, _ = select.select([fd], [], [], 0.01)
        if not r: continue
        try: buf += os.read(fd, 4096)
        except BlockingIOError: continue
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            s = line.decode(errors="replace")
            extra = ""
            parts = s.split()
            if len(parts) >= 3 and parts[0] in "OHAE" and len(parts[2]) == 14:
                extra = f"  (cycle {int(parts[2], 16):,})"
            print(f"{time.time()-t0:8.3f}s  {s}{extra}")
for c in a.cmds:
    os.write(fd, (c + "\n").encode())
    print(f"{time.time()-t0:8.3f}s  > {c}")
    pump(time.time() + a.gap)
pump(time.time() + a.secs)
os.close(fd)
