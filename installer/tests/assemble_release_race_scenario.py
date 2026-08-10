#!/usr/bin/env python3
"""Race regression scenario for scripts/assemble_release.py.

The node host test builds a valid three-variant asset tree at the
paths this script expects, then runs this script as a subprocess. The
script imports assemble_release.py, monkeypatches the staging
boundary so an empty destination directory appears AFTER the
assembler's initial existence check but BEFORE its rename, then calls
_assemble. It exits 0 only when the assembler raises AssemblyError
AND the injected destination is inode-stable.

Against the current head, the sibling publication lock plus the
pre-rename existence check both fire: _assemble raises, and the
injected directory is left untouched. Against blocked parent
f2a7535, os.rename silently replaces the empty destination and
_assemble completes without raising; this script then exits non-zero
because no exception was seen and the inode is not preserved.

Arguments (all required):
    --script      path to scripts/assemble_release.py
    --tag         matrix release tag
    --variants    path to firmware/variants.json
    --assets      local directory containing <TAG>/<variant>/ packages
    --out         final destination path (must NOT exist at entry)
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path


def _load_module(script_path: Path):
    spec = importlib.util.spec_from_file_location("assemble_release", script_path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load module from {script_path}")
    module = importlib.util.module_from_spec(spec)
    # Register in sys.modules before exec_module so decorators like
    # @dataclass can look up the module by name during class creation.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--variants", required=True, type=Path)
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv[1:])

    if args.out.exists():
        print(f"scenario error: {args.out} must not exist at entry", file=sys.stderr)
        return 2

    module = _load_module(args.script)
    variants_json = module._read_json(args.variants)

    # Monkeypatch _stage_variant so its FIRST call creates the empty
    # destination directory. This lands at the exact race point:
    # after the assembler's initial existence check, before the
    # rename. The recorded inode lets us prove the destination was
    # not replaced by a silent rename.
    recorded = {"inode": None, "injected": False}
    original_stage = module._stage_variant

    def _hooked(stage, verified):
        if not recorded["injected"]:
            os.makedirs(args.out)
            recorded["inode"] = os.stat(args.out).st_ino
            recorded["injected"] = True
        return original_stage(stage, verified)

    module._stage_variant = _hooked

    raised = None
    try:
        module._assemble(args.tag, variants_json, args.assets, args.out)
    except module.AssemblyError as exc:
        raised = str(exc)

    if not recorded["injected"]:
        print("scenario error: monkeypatch never fired; _stage_variant was not called",
              file=sys.stderr)
        return 2

    if raised is None:
        print("PROOF: assembler did not raise; a racing empty destination was accepted",
              file=sys.stderr)
        return 1

    if not args.out.exists():
        print(f"PROOF: injected destination {args.out} vanished after failed publication",
              file=sys.stderr)
        return 1

    current_inode = os.stat(args.out).st_ino
    if current_inode != recorded["inode"]:
        print(f"PROOF: destination inode changed from {recorded['inode']} to {current_inode}",
              file=sys.stderr)
        return 1

    print(f"assembler raised: {raised}")
    print(f"destination inode preserved: {current_inode}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
