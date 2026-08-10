#!/usr/bin/env python3
# Minimal esptool.py stand-in for prepare_release.sh fixture tests.
#
# Understands one command:
#   esptool.py --chip <chip> merge_bin --flash_mode dio --flash_freq 80m
#              --flash_size <SIZE> --fill-flash-size <SIZE>
#              -o <output> <offset> <file> [<offset> <file> ...]
#
# It reads each part file, splices it at its offset into a buffer of
# size <SIZE> padded with 0xFF, and writes the result to <output>.
# All other commands or flags are rejected. The purpose is to let the
# host tests exercise the atomic-publication code path without a real
# ESP-IDF toolchain.

import sys

def parse_size(text):
    unit = text[-2:]
    value = int(text[:-2])
    return value * {"KB": 1024, "MB": 1024 * 1024}[unit]

def main(argv):
    args = list(argv[1:])
    if "merge_bin" not in args:
        print(f"mock-esptool: only merge_bin is supported (got {args})", file=sys.stderr)
        return 2

    chip = ""
    if args[0] == "--chip":
        chip = args[1]
        args = args[2:]
    if not args or args[0] != "merge_bin":
        print("mock-esptool: expected merge_bin as the first subcommand", file=sys.stderr)
        return 2
    args = args[1:]

    flash_size = None
    output = None
    parts = []
    it = iter(args)
    for token in it:
        if token in ("--flash_mode", "--flash_freq"):
            next(it)  # consume the value; do not care in the mock
        elif token == "--flash_size":
            flash_size = parse_size(next(it))
        elif token == "--fill-flash-size":
            parse_size(next(it))  # ignored, only informational for the mock
        elif token == "-o":
            output = next(it)
        elif token.startswith("--"):
            print(f"mock-esptool: unsupported flag {token}", file=sys.stderr)
            return 2
        else:
            offset_hex = token
            path = next(it)
            parts.append((int(offset_hex, 16), path))

    if flash_size is None or output is None or not parts:
        print("mock-esptool: missing --flash_size, -o, or parts", file=sys.stderr)
        return 2

    image = bytearray(b"\xff" * flash_size)
    for offset, path in parts:
        with open(path, "rb") as f:
            data = f.read()
        end = offset + len(data)
        if end > flash_size:
            print(f"mock-esptool: part {path} at {offset:#x} exceeds flash size", file=sys.stderr)
            return 2
        image[offset:end] = data
    with open(output, "wb") as f:
        f.write(image)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
