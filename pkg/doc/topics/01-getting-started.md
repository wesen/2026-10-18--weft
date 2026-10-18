---
Title: Getting started with weft and the GateMateA1-EVB
Slug: getting-started
Short: Check the toolchain and the board, then open Weft Lab on your machine.
Topics:
- gatemate
- toolchain
- lab
Commands:
- doctor
- serve
IsTemplate: false
IsTopLevel: true
ShowPerDefault: true
SectionType: GeneralTopic
---

`weft` serves Weft Lab locally and turns Weft designs into bitstreams for the
Olimex GateMateA1-EVB with the open-source GateMate flow (yosys,
nextpnr-himbaechel, gmpack, openFPGALoader).

## 1. Check the machine

    weft doctor

Every row should say `ok: true`. The common failures:

- **oss-cad-suite** — unpack the OSS CAD Suite to `~/fpga/oss-cad-suite`, or
  pass `--oss-cad-suite <dir>`.
- **board** — the RP2040 programmer (USB `1209:c0ca`, DirtyJTAG) is not
  visible. Check the cable, and that your user may open the USB device.
- **serial** — `/dev/ttyACM0` is missing. Load the CDC driver once with
  `sudo modprobe cdc_acm`. Board-level validation reads the FPGA's UART there.

Use `--skip-board` to check the toolchain without touching the cable.

## 2. Open the Lab

    weft serve
    # → http://127.0.0.1:8088/

The server only listens on loopback, and only answers requests whose Host
header is exactly the `--listen` address. Saved designs live in the browser's
localStorage for that origin, so keep the same address between runs.

`--lab-file weft-lab/app/dist/index.html` serves a freshly built page from disk
instead of the copy embedded in the binary, which is handy while editing the
Lab's source.
