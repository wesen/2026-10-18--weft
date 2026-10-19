#!/usr/bin/env python3
"""Send text to the FPGA's UART and print what comes back (P7: F-16 "shout" upcases what it receives).

usage: 07-uart-echo.py [device] [text]   (default /dev/ttyACM0, "hello, fabric\\n"; 115200 8N1, raw)

The RP2040's USB-to-UART bridge has no flow control: it takes USB data far faster than 115200 baud and drops
what overflows its buffer (bursts beyond about 2 KB). The script keeps at most 1 KB in flight, which still
keeps the line busy at its full rate.
"""
import os, sys, termios, time

dev = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyACM0"
text = (sys.argv[2] if len(sys.argv) > 2 else "hello, fabric\n").encode()
fd = os.open(dev, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
attrs = termios.tcgetattr(fd)
attrs[0] = 0                                     # iflag: no translation
attrs[1] = 0                                     # oflag: raw output
attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
attrs[3] = 0                                     # lflag: no echo, no canonical mode
attrs[4] = attrs[5] = termios.B115200
termios.tcsetattr(fd, termios.TCSANOW, attrs)
termios.tcflush(fd, termios.TCIOFLUSH)
# drain what the programmer buffered while nobody read the port (the previous design's output)
drained, quiet = 0, time.monotonic()
while time.monotonic() - quiet < 0.2:
    try:
        n = len(os.read(fd, 4096))
        drained += n
        if n:
            quiet = time.monotonic()
    except BlockingIOError:
        time.sleep(0.005)
if drained:
    print(f"drained {drained} stale bytes")
t0 = time.monotonic()
deadline = 1.0 + 1.5 * len(text) * 10 / 115200   # seconds: the line's own time, with margin
sent, got = 0, b""
while time.monotonic() - t0 < deadline and len(got) < len(text):
    if sent < len(text) and sent - len(got) < 1024:   # non-blocking: the driver takes what fits
        try:
            sent += os.write(fd, text[sent:sent + 256])
        except BlockingIOError:
            pass
    try:
        got += os.read(fd, 4096)
    except BlockingIOError:
        time.sleep(0.001)
os.close(fd)
print(f"sent {text!r}")
print(f"got  {got!r} after {(time.monotonic() - t0) * 1000:.1f} ms")
sys.exit(0 if got else 1)
