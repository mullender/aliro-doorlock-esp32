#!/usr/bin/env python3
"""Assemble a local matrix release directory from verified packages.

The assembler is network-free. It reads three per-variant packages that
scripts/prepare_release.sh produced, verifies each one against
firmware/variants.json, and writes one ESP Web Tools factory manifest
plus one preserving-update manifest per variant into a fresh output
directory. It fails closed before it publishes anything if any package
is missing, malformed, inconsistent, or does not match the approved
identity for its variant.

Usage:

    scripts/assemble_release.py \\
        --tag aliro-v0.0.6-devkit \\
        --variants firmware/variants.json \\
        --assets  <dir containing <TAG>/<VARIANT>/> \\
        --out     <new output dir>

The assets tree must follow the layout that prepare_release.sh writes:

    <assets>/<TAG>/<VARIANT>/<TAG>-<VARIANT>-factory.bin
                             <TAG>-<VARIANT>-factory.bin.sha256
                             <TAG>-<VARIANT>-app.bin
                             <TAG>-<VARIANT>-app.bin.sha256
                             <TAG>-<VARIANT>-manifest.txt

The output layout is flat and holds four asset files plus two
manifests per variant:

    <out>/<TAG>-<VARIANT>-factory.bin
          <TAG>-<VARIANT>-factory.bin.sha256
          <TAG>-<VARIANT>-app.bin
          <TAG>-<VARIANT>-app.bin.sha256
          <manifest_factory>              # from variants.json
          <manifest_update>               # from variants.json

The manifests use the ESP Web Tools schema. The factory manifest keeps
`new_install_prompt_erase` false so a variant or transport change
always erases the flash. The update manifest keeps it true so the
installer's dialog guard can force the keep-setup path; it writes the
app image at both approved OTA offsets.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

TAG_PATTERN = re.compile(r"^aliro-v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$")
REQUIRED_VARIANT_IDS = ("nanoc6-thread", "nanoc6-wifi", "atoms3-lite-wifi")


class AssemblyError(Exception):
    """A fail-closed assembly problem. The message ships to stderr."""


@dataclass(frozen=True)
class VariantSpec:
    variant_id: str
    project_name: str
    chip: str
    chip_family: str
    flash_size: str
    partition_table_sha256: str
    ota_slot_size: int
    ota_offsets: Tuple[int, ...]
    product_label: str
    improv_wait_time: int
    manifest_factory: str
    manifest_update: str


def _die(message: str) -> None:
    raise AssemblyError(message)


def _parse_hex_int(text: str, field: str) -> int:
    if not isinstance(text, str) or not text:
        _die(f"{field}: expected a hex string, got {text!r}")
    try:
        return int(text, 16)
    except ValueError as exc:
        _die(f"{field}: {exc}")


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        _die(f"missing file: {path}")
    except json.JSONDecodeError as exc:
        _die(f"malformed JSON in {path}: {exc}")


def _load_variant_spec(variants_json: dict, variant_id: str) -> VariantSpec:
    variants = variants_json.get("variants") or {}
    entry = variants.get(variant_id)
    if entry is None:
        _die(f"variant {variant_id!r} is missing in variants.json")

    for field in ("id", "project_name", "chip", "chip_family", "flash_size",
                  "partition_table_sha256", "ota_slot_size_hex",
                  "ota_offsets_hex", "manifest_factory", "manifest_update"):
        if entry.get(field) is None or entry.get(field) == "":
            _die(f"{variant_id}: variants.json field {field!r} is missing or null")
    if entry["id"] != variant_id:
        _die(f"{variant_id}: variants.json entry id is {entry['id']!r}")

    part_sha = entry["partition_table_sha256"]
    if not isinstance(part_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", part_sha):
        _die(f"{variant_id}: partition_table_sha256 must be a 64-char lowercase hex SHA-256")

    ota_slot = _parse_hex_int(entry["ota_slot_size_hex"], f"{variant_id}.ota_slot_size_hex")
    offsets = tuple(_parse_hex_int(o, f"{variant_id}.ota_offsets_hex[{i}]")
                    for i, o in enumerate(entry["ota_offsets_hex"]))
    if not offsets:
        _die(f"{variant_id}: ota_offsets_hex must contain at least one offset")

    return VariantSpec(
        variant_id=variant_id,
        project_name=entry["project_name"],
        chip=entry["chip"],
        chip_family=entry["chip_family"],
        flash_size=entry["flash_size"],
        partition_table_sha256=part_sha,
        ota_slot_size=ota_slot,
        ota_offsets=offsets,
        product_label=entry.get("product_label") or entry["project_name"],
        improv_wait_time=int(entry.get("improv_wait_time") or 0),
        manifest_factory=entry["manifest_factory"],
        manifest_update=entry["manifest_update"],
    )


def _parse_flash_size(text: str) -> int:
    unit = text[-2:]
    value = text[:-2]
    if unit not in ("KB", "MB") or not value.isdigit():
        _die(f"flash_size {text!r} not understood; expected e.g. 4MB")
    multiplier = 1024 if unit == "KB" else 1024 * 1024
    return int(value) * multiplier


def _read_sidecar(path: Path, expected_name: str) -> str:
    if not path.exists():
        _die(f"missing sidecar: {path}")
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        _die(f"empty sidecar: {path}")
    parts = text.split()
    if len(parts) < 2:
        _die(f"malformed sidecar (need '<sha>  <name>'): {path}")
    sha, name = parts[0].lower(), parts[1]
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        _die(f"malformed SHA-256 in sidecar {path}: {parts[0]!r}")
    if name != expected_name:
        _die(f"sidecar {path} names {name!r}; expected {expected_name!r}")
    return sha


def _sha256_of(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _parse_manifest_txt(path: Path) -> Dict[str, str]:
    if not path.exists():
        _die(f"missing package manifest: {path}")
    entries: Dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        entries[key.strip()] = value.strip()
    return entries


def _tag_firmware_version(tag: str) -> str:
    if not TAG_PATTERN.match(tag):
        _die(f"--tag must match aliro-vX.Y.Z-devkit (got {tag!r})")
    return tag[len("aliro-v"):]


def _verify_variant(tag: str, spec: VariantSpec, variant_dir: Path,
                    firmware_version: str) -> Dict[str, object]:
    if not variant_dir.is_dir():
        _die(f"{spec.variant_id}: missing variant directory {variant_dir}")

    stem = f"{tag}-{spec.variant_id}"
    factory = variant_dir / f"{stem}-factory.bin"
    factory_sha = variant_dir / f"{stem}-factory.bin.sha256"
    app = variant_dir / f"{stem}-app.bin"
    app_sha = variant_dir / f"{stem}-app.bin.sha256"
    manifest_txt = variant_dir / f"{stem}-manifest.txt"

    for required in (factory, factory_sha, app, app_sha, manifest_txt):
        if not required.exists():
            _die(f"{spec.variant_id}: missing required package file {required}")

    # Refuse any extra files whose stem does not belong to this variant.
    expected_names = {p.name for p in (factory, factory_sha, app, app_sha, manifest_txt)}
    for entry in sorted(variant_dir.iterdir()):
        if entry.name not in expected_names:
            _die(f"{spec.variant_id}: unexpected file {entry.name} in package directory")

    # Sidecars: compare declared and computed digests.
    factory_declared = _read_sidecar(factory_sha, factory.name)
    app_declared = _read_sidecar(app_sha, app.name)
    factory_sha_actual = _sha256_of(factory)
    app_sha_actual = _sha256_of(app)
    if factory_declared != factory_sha_actual:
        _die(f"{spec.variant_id}: factory sidecar {factory_declared} != content {factory_sha_actual}")
    if app_declared != app_sha_actual:
        _die(f"{spec.variant_id}: app sidecar {app_declared} != content {app_sha_actual}")

    # Audit manifest identity.
    entries = _parse_manifest_txt(manifest_txt)
    identity = {
        "tag": tag,
        "variant": spec.variant_id,
        "project_name": spec.project_name,
        "project_version": firmware_version,
        "chip": spec.chip,
        "flash_size": spec.flash_size,
    }
    for key, expected in identity.items():
        actual = entries.get(key)
        if actual != expected:
            _die(f"{spec.variant_id}: manifest {key!r} is {actual!r}; expected {expected!r}")

    # Factory image must be exactly the variant's flash_size, padded.
    flash_bytes = _parse_flash_size(spec.flash_size)
    factory_size = factory.stat().st_size
    if factory_size != flash_bytes:
        _die(f"{spec.variant_id}: factory image is {factory_size} bytes; expected {flash_bytes} ({spec.flash_size})")

    # App image must fit inside a single OTA slot.
    app_size = app.stat().st_size
    if app_size == 0 or app_size > spec.ota_slot_size:
        _die(f"{spec.variant_id}: app image is {app_size} bytes; OTA slot limit is {spec.ota_slot_size} bytes")

    # Approved partition table at 0xC000 for 0xC00 bytes.
    with factory.open("rb") as source:
        source.seek(0xC000)
        partition_bytes = source.read(0xC00)
    if len(partition_bytes) != 0xC00:
        _die(f"{spec.variant_id}: factory image does not have 0xC00 bytes at 0xC000")
    partition_sha = hashlib.sha256(partition_bytes).hexdigest()
    if partition_sha != spec.partition_table_sha256:
        _die(f"{spec.variant_id}: embedded partition SHA {partition_sha} != approved "
             f"{spec.partition_table_sha256}")

    # App bytes embedded at 0x20000 must equal the standalone app.bin.
    first_offset = spec.ota_offsets[0]
    with factory.open("rb") as source:
        source.seek(first_offset)
        embedded_app = source.read(app_size)
    if len(embedded_app) != app_size:
        _die(f"{spec.variant_id}: factory image ends before offset {first_offset:#x} + app_size")
    embedded_sha = hashlib.sha256(embedded_app).hexdigest()
    if embedded_sha != app_sha_actual:
        _die(f"{spec.variant_id}: embedded app SHA {embedded_sha} != standalone app SHA {app_sha_actual}")

    return {
        "spec": spec,
        "factory": factory,
        "factory_sha": factory_sha,
        "factory_sha_hex": factory_sha_actual,
        "app": app,
        "app_sha": app_sha,
        "app_sha_hex": app_sha_actual,
        "app_size": app_size,
        "manifest_txt": manifest_txt,
    }


def _build_factory_manifest(tag: str, spec: VariantSpec, factory_name: str) -> dict:
    return {
        "name": spec.product_label,
        "version": tag,
        # Factory install must erase for a transport or board change.
        # Setting this false makes ESP Web Tools auto-erase; the caller
        # never sees an ASK_ERASE step.
        "new_install_prompt_erase": False,
        "new_install_improv_wait_time": spec.improv_wait_time,
        "builds": [{
            "chipFamily": spec.chip_family,
            "parts": [{"path": factory_name, "offset": 0}],
        }],
    }


def _build_update_manifest(tag: str, spec: VariantSpec, app_name: str) -> dict:
    return {
        "name": f"{spec.product_label} — keep-setup update",
        "version": tag,
        # Preserving update: the installer's update-dialog guard hides
        # the ASK_ERASE checkbox so the keep-setup path always runs.
        "new_install_prompt_erase": True,
        "new_install_improv_wait_time": spec.improv_wait_time,
        "builds": [{
            "chipFamily": spec.chip_family,
            "parts": [
                {"path": app_name, "offset": offset}
                for offset in spec.ota_offsets
            ],
        }],
    }


def _stage_variant(stage: Path, verified: Dict[str, object]) -> None:
    spec: VariantSpec = verified["spec"]  # type: ignore[assignment]
    factory: Path = verified["factory"]   # type: ignore[assignment]
    factory_sha: Path = verified["factory_sha"]  # type: ignore[assignment]
    app: Path = verified["app"]           # type: ignore[assignment]
    app_sha: Path = verified["app_sha"]   # type: ignore[assignment]

    # Copy the four verified assets and their sidecars.
    for source in (factory, factory_sha, app, app_sha):
        shutil.copyfile(source, stage / source.name)

    # Write the two manifests. File names come from variants.json.
    (stage / spec.manifest_factory).write_text(
        json.dumps(_build_factory_manifest(_current_tag[0], spec, factory.name), indent=2),
        encoding="utf-8",
    )
    (stage / spec.manifest_update).write_text(
        json.dumps(_build_update_manifest(_current_tag[0], spec, app.name), indent=2),
        encoding="utf-8",
    )


_current_tag = [""]  # cheap thread-local-style storage for _stage_variant


def _assemble(tag: str, variants_json: dict, assets_root: Path, out_dir: Path) -> None:
    firmware_version = _tag_firmware_version(tag)

    tag_root = assets_root / tag
    if not tag_root.is_dir():
        _die(f"assets directory {assets_root} does not contain a {tag}/ subdirectory")

    # Publication lock. Acquire the sibling lock BEFORE the destination
    # existence check so a racing assembler cannot slip an empty
    # destination directory in between the check and the final rename.
    # POSIX os.rename can silently replace an empty destination
    # directory; the lock serializes every assembler publisher for this
    # output. The lock is released on all failure and success paths.
    out_parent = out_dir.parent
    out_parent.mkdir(parents=True, exist_ok=True)
    lock_dir = out_parent / f".{out_dir.name}.publish.lock"
    try:
        lock_dir.mkdir()
    except FileExistsError:
        _die(f"another assembler holds the publication lock at {lock_dir}; "
             f"if no publisher is running, remove the stale lock directory explicitly")

    stage: object = None
    try:
        # Refuse to overwrite an existing output directory. A caller that
        # wants to reassemble must delete the directory explicitly.
        if out_dir.exists():
            _die(f"output directory {out_dir} already exists; refusing to overwrite")

        # Verify every variant BEFORE any output is written.
        verified_by_variant = {}
        for variant_id in REQUIRED_VARIANT_IDS:
            spec = _load_variant_spec(variants_json, variant_id)
            variant_dir = tag_root / variant_id
            verified_by_variant[variant_id] = _verify_variant(tag, spec, variant_dir, firmware_version)

        # Confirm the three variants are the exact set. An asset
        # directory with a fourth per-variant subdirectory could hide
        # a smuggled release and is treated as inconsistent input.
        extras = sorted(entry.name for entry in tag_root.iterdir()
                        if entry.is_dir() and entry.name not in REQUIRED_VARIANT_IDS)
        if extras:
            _die(f"assets tree contains unexpected variant directories: {extras}")

        # Stage the whole output in a private tmpdir on the same
        # filesystem as OUT_DIR, then rename to the final path in one
        # atomic move.
        stage = Path(tempfile.mkdtemp(prefix=f".{out_dir.name}.stage.", dir=out_parent))
        _current_tag[0] = tag
        for variant_id in REQUIRED_VARIANT_IDS:
            _stage_variant(stage, verified_by_variant[variant_id])
        # Recheck the destination immediately before rename. The lock
        # protects against a racing assembler; this guard also covers a
        # non-assembler writer that made the directory outside the lock.
        if out_dir.exists():
            _die(f"output directory {out_dir} appeared during staging; refusing to overwrite")
        try:
            os.rename(stage, out_dir)
        except OSError as exc:
            if exc.errno in (errno.EEXIST, errno.ENOTEMPTY, errno.EISDIR):
                _die(f"refusing to overwrite {out_dir} (errno={exc.errno})")
            raise
        stage = None  # mark consumed so cleanup skips it
    finally:
        if isinstance(stage, Path) and stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        # Release the lock on every exit path.
        try:
            lock_dir.rmdir()
        except OSError:
            pass


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Assemble a network-free matrix release directory.",
    )
    parser.add_argument("--tag", required=True,
                        help="matrix release tag, e.g. aliro-v0.0.6-devkit")
    parser.add_argument("--variants", required=True, type=Path,
                        help="path to firmware/variants.json")
    parser.add_argument("--assets", required=True, type=Path,
                        help="local directory containing <TAG>/<variant>/ packages")
    parser.add_argument("--out", required=True, type=Path,
                        help="new output directory (must not exist)")
    args = parser.parse_args(argv[1:])

    variants_json = _read_json(args.variants)
    try:
        _assemble(args.tag, variants_json, args.assets, args.out)
    except AssemblyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    print(f"Assembled matrix release under {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
