# GHCR host rollout: controlled and reversible

The official GHCR publisher and immutable proof acceptance passed for
[v0.1.42](https://github.com/b8vipvip/mv3c/releases/tag/v0.1.42).
The proof binds that Release commit to
`ghcr.io/b8vipvip/mv3c@sha256:4fb83e197539a61585fc80f79ddb7f259cddd65c913cee69a6a9c2594d8c189d`.
The GHCR historical comparison measured 377,859,634 bytes of identical
compressed blobs (v0.1.37 to v0.1.38), **not actual host traffic savings**.

## Before any host-side opt-in

- Keep production `MV3C_OCI_LAYER_TRANSPORT` unset. The GitHub Actions
  `MV3C_ENABLE_OCI_REGISTRY=enabled` setting controls publishing only.
- Confirm an external disk snapshot and a known-good `mv3c:rollback` image.
  Do not delete database volumes, shared Docker/BuildKit caches, or rollback.
- Do not start a second updater. Only the existing
  `mv3c-updater.service` with its flock and MongoDB job is authorized.
- The host checkout must contain the OCI-aware canonical updater and the
  previously fetched protected Git tags. Missing local tags must **not**
  be bypassed with an unverified digest or unpinned `latest` tag.

Run the **read-only** preflight from the target-version checkout after the
canonical updater has fetched the signed-off Release refs:

```sh
sudo python3 -B /opt/mv3c/mv3c/updater/oci_host_preflight.py \
  --repo /opt/mv3c \
  --version v0.1.42 \
  --sha 81e46eb6b02b5faeb825219a161209225d13c769
```

It checks local Release/OCI proof, Docker root **filesystem** free bytes,
actual conservative updater disk budget, present local image, idle updater
service, and existing service readyz. It does not pull, download, tag, deploy,
fetch Git refs, change timer/config, or clean Docker data. A failed check means
**do not proceed**; if a host is on an older checkout, first follow the
existing one-time archive bootstrap rather than bypassing proof checks. The
bootstrap intentionally continues using the full attested archive for the
one-time handoff and now stages `agent.py`, `prebuilt.py`, and
`oci_registry.py` from exactly the same Release tree.

## Separate host opt-in, only after preflight and rollback review

The canonical installer supports optional root-only
`/etc/mv3c/updater-oci.env`. It must be a **regular**, root-owned file
without group/other permissions. If absent, GHCR is disabled. Only after
approval of a controlled host rollout and successful preflight may an
administrator set:

```ini
MV3C_OCI_LAYER_TRANSPORT=enabled
```

The existing canonical service must be reinstalled/reloaded safely for its
EnvironmentFile configuration to apply; do not add a separate service or use
a systemd drop-in. The host must also have public GHCR network access; the
Actions runner's success does not prove this host's network throughput.

An OCI pull must use **the digest in the protected Release image proof**,
verify image ID/revision/version/source and keep 2 GiB switch reserve.
Network failure may fall back to the fully attested GitHub Release archive;
identity mismatch must fail closed. Monitor actual transfer bytes, Docker
root free-space minimum, health and rollback in the canonical diagnostic log.
Do not interpret a passing read-only preflight as deployment acceptance.

The public GHCR publication is optional; the existing Release tar.gz
transport remains authoritative fallback. On any unresolved host issue,
leave `MV3C_OCI_LAYER_TRANSPORT` unset and continue the proven archive path.
