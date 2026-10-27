#!/usr/bin/env python3
"""Read-only audit of *compressed* OCI layers published to GHCR.

DiffIDs from docker image inspect are hashes of UNCOMPRESSED layers, and are
not sufficient to claim registry transfer savings. This tool compares registry
manifest blob digests and their compressed sizes, without pulling the image.
"""
import argparse
import json
import re
import subprocess


def manifest(ref):
    result = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", "--raw", ref],
        check=True, capture_output=True, text=True, timeout=120,
    )
    obj = json.loads(result.stdout)
    if not isinstance(obj.get("layers"), list):
        raise ValueError("Expected a single-platform image manifest containing layers")
    return obj


def layers(obj):
    records = []
    for item in obj["layers"]:
        digest, size = item.get("digest"), item.get("size")
        if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ValueError("Invalid OCI layer digest")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ValueError("Invalid OCI compressed layer size")
        records.append((digest, size))
    return records


def compare(current, previous=None):
    now = layers(current)
    before = layers(previous) if previous is not None else []
    previous_blobs = dict(before)
    reused = sum(size for digest, size in now if previous_blobs.get(digest) == size)
    total = sum(size for _, size in now)
    return {
        "compressed_total_bytes": total,
        "compressed_reusable_bytes": reused if previous is not None else None,
        "compressed_new_bytes": total - reused if previous is not None else None,
        "same_position_digests": [
            i + 1 for i, row in enumerate(now)
            if i < len(before) and row == before[i]
        ],
        "layers": [{"position": i + 1, "digest": d, "compressed_bytes": s,
                    "in_previous_manifest": previous_blobs.get(d) == s if previous is not None else None}
                   for i, (d, s) in enumerate(now)],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", required=True)
    parser.add_argument("--previous", default="")
    args = parser.parse_args()
    current = manifest(args.current)
    previous = None
    error = ""
    if args.previous:
        try:
            previous = manifest(args.previous)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as exc:
            error = str(exc).splitlines()[0][:240]
    audit = compare(current, previous)
    audit["current_ref"] = args.current
    audit["previous_ref"] = args.previous or None
    audit["previous_available"] = previous is not None
    audit["previous_lookup_error"] = error
    print(json.dumps(audit, indent=2, sort_keys=True))
    # This is *potential* blob reuse, not measured network traffic or disk usage.
    import os
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            out.write("\n### GHCR compressed OCI layer audit\n")
            out.write(f"- Current: \`{args.current}\`\n")
            out.write(f"- Current compressed layer bytes: {audit['compressed_total_bytes']}\n")
            out.write(f"- Previous manifest available: {audit['previous_available']}\n")
            if previous is not None:
                out.write(f"- Previous: \`{args.previous}\`\n")
                out.write(f"- Reusable compressed blob bytes (potential): {audit['compressed_reusable_bytes']}\n")
                out.write(f"- New compressed blob bytes (potential): {audit['compressed_new_bytes']}\n")
            out.write("- These are manifest blob sizes, **not measured download savings**.\n")


if __name__ == "__main__":
    main()
