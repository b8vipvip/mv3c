#!/usr/bin/env python3
"""Report potential OCI layer reuse BEFORE claiming any traffic savings.

RootFS diffIDs describe unpacked content. The registry reuses compressed OCI
blob digests, which must also match. This report is an upper bound, not a
promise that Docker will download only the changed application layer.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")


def validated_layers(values: object) -> list[str]:
    if not isinstance(values, list) or len(values) > 200 or not values:
        raise ValueError("Invalid image rootfs layers")
    if not all(isinstance(value, str) and DIGEST.fullmatch(value) for value in values):
        raise ValueError("Malformed image layer ID")
    return values


def compare_layers(current: list[str], previous: list[str]) -> dict:
    latest = validated_layers(current)
    prior = validated_layers(previous) if previous else []
    # Do not confuse unique diffID intersection with matching layer POSITIONS.
    # Two empty metadata-producing layers can share a single diffID, causing
    # the older set-intersection count to understate matched positions.
    shared = len(set(latest).intersection(prior))
    matching_positions = [
        i + 1 for i, (left, right) in enumerate(zip(latest, prior))
        if left == right
    ]
    changed_positions = [
        i + 1 for i, (left, right) in enumerate(zip(latest, prior))
        if left != right
    ] + list(range(len(prior) + 1, len(latest) + 1))
    common_prefix = 0
    for left, right in zip(latest, prior):
        if left != right:
            break
        common_prefix += 1
    return {"layers": len(latest), "shared_diff_ids": shared,
            "identical_positions": matching_positions,
            "different_positions": changed_positions,
            "identical_position_count": len(matching_positions),
            "shared_base_prefix": common_prefix,
            "new_diff_ids": len(latest) - shared,
            "previous_available": bool(prior)}


def dependency_layer_fingerprint(layers: list[str], position: int = 9) -> str | None:
    """Identify the known prod-deps COPY layer without equating it to bytes saved.

    The currently audited runtime has 10 non-empty layers. A future Dockerfile
    reordering makes position 9 unavailable rather than reporting a false hit.
    """
    items = validated_layers(layers)
    if len(items) != 10 or position != 9:
        return None
    return items[position - 1]


def previous_proof_diff_ids(text: str) -> list[str]:
    matching = [line.removeprefix("rootfs_diff_ids=")
                for line in text.splitlines()
                if line.startswith("rootfs_diff_ids=")]
    if not matching:
        return []
    if len(matching) != 1:
        raise ValueError("Duplicate previous rootfs_diff_ids proof")
    return validated_layers(matching[0].split(","))


def main() -> int:
    sha = os.environ["RELEASE_SHA"]
    version = os.environ["VERSION"]
    current = json.loads(subprocess.check_output(
        ["docker", "image", "inspect", "--format", "{{json .RootFS.Layers}}",
         "mv3c:sha-" + sha], text=True))
    latest = validated_layers(current)
    refs = subprocess.check_output(
        ["git", "tag", "--list", "mv3c-image/v*"], text=True).splitlines()
    versions = []
    for ref in refs:
        m = re.fullmatch(r"mv3c-image/v(\d+)\.(\d+)\.(\d+)", ref)
        if m is None:
            continue
        v = tuple(map(int, m.groups()))
        mine = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", version)
        if mine and v < tuple(map(int, mine.groups())):
            versions.append((v, ref))
    previous = []
    previous_version = "-"
    if versions:
        previous_version = max(versions)[1]
        text = subprocess.check_output(
            ["git", "cat-file", "-p", "refs/tags/" + previous_version], text=True)
        previous = previous_proof_diff_ids(text)
    result = compare_layers(latest, previous)
    dependency = dependency_layer_fingerprint(latest)
    older_dependency = dependency_layer_fingerprint(previous) if previous else None
    dependency_same = bool(dependency and older_dependency and dependency == older_dependency)
    print("Potential OCI layer reuse (uncompressed diffIDs only):", result)
    print("Current production dependency layer 9 diffID:", dependency or "unavailable")
    print("Previous attested dependency layer 9 diffID:", older_dependency or "unavailable")
    print("Production dependency layer 9 unchanged:", dependency_same)
    print("Previous attested image:", previous_version)
    with open(os.environ["GITHUB_OUTPUT"], "a") as out:
        print("rootfs_diff_ids=" + ",".join(latest), file=out)
        print("shared_prefix=" + str(result["shared_base_prefix"]), file=out)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as out:
        print("### OCI layer reuse audit (not bytes saved)", file=out)
        print(f"Attested image: {version} ({len(latest)} rootfs diffIDs)", file=out)
        print(f"Previous: {previous_version}", file=out)
        print(f"Potential shared diffIDs: {result['shared_diff_ids']}", file=out)
        print(f"Identical layer positions: {result['identical_positions']}", file=out)
        print(f"Different layer positions: {result['different_positions']}", file=out)
        print(f"Potential shared prefix: {result['shared_base_prefix']}", file=out)
        print(f"Production dependency layer 9 stable: {dependency_same}", file=out)
        print(f"Layer 9 current diffID: {dependency or 'not measurable'}", file=out)
        print(f"Layer 9 preceding diffID: {older_dependency or 'not measurable'}", file=out)
        print("Compressed layer digests and actual host transfer must still be"
              " measured before claiming bandwidth savings.", file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
