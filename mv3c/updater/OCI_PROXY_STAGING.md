# MV3C official GHCR proxy transport — controlled release candidate path

This is one **optional transport** inside the EXISTING canonical MV3C
`prebuilt.import_prebuilt()` route, not a second updater or deployment worker.
**Default is disabled**. Do not opt in on the production 40 GiB host until the
next official release has a signed GHCR proof, its Docker 29 OCI import/rollback
has been accepted, and the server preflight is green.

## Verified building blocks

- `oci_proxy_manifest.py` reads the exact Release-Git-protected manifest
  by immutable SHA256, validates single-platform descriptors, config ID,
  OCI runtime labels, environment and RootFS diffIDs.
- `oci_proxy_blob.py` downloads a SHA256-addressed compressed blob from GHCR
  through an unauthenticated loopback proxy. It uses HTTP Range continuation,
  fails closed on hash/size mismatch, retains partials on connection failure,
  prevents symlinks and protects minimum free disk space.
- `oci_proxy_archive.py` rehashes every staged layer, builds an OCI image
  layout .tar with the original *compressed* bytes, and publishes the archive
  atomically after complete validation.
- `oci_proxy_import.py` rereads and rehashes the OCI archive, imports using
  Docker's supported `docker image load` command (never direct writes into
  containerd), checks the pinned manifest digest, runtime labels, env and
  RootFS, and only THEN tags `mv3c:sha-<release-sha>`. It never changes
  `mv3c:local`, `mv3c:rollback`, or the running service.
- The existing agent still owns the original flock/MongoDB job, old-image
  rollback and health checks. A cached OCI archive is reverified before
  the agent accepts an imported manifest-digest candidate without RepoDigests.

## Host opt-in (DO NOT use until controlled production acceptance)

`MV3C_OCI_PROXY_TRANSPORT=required` selects **only** this verified
proxy path. No secondary GHCR pull or full-archive fallback occurs on failure.
`MV3C_OCI_PROXY_TRANSPORT=enabled` allows a signed full-archive fallback.
This is distinct from the legacy direct-Docker
`MV3C_OCI_LAYER_TRANSPORT=enabled|required`; setting both is rejected.
Existing unconfigured deployments use the old behavior unchanged.

The root-owned host update unit must already read the existing secure
`MV3C_DOWNLOAD_PROXY=socks5h://127.0.0.1:11808`, and have a root-only,
non-world-readable `/etc/mv3c/updater-oci.env` before opt-in.
The updater config/systemd files are NOT modified by this PR.
Cache: `/var/lib/mv3c-prebuilt/verified/oci-blob-cache/`, mode 0700.

## Safety and observability

- GitHub's annotated Release image proof remains the root of trust.
- A short/failed HTTP download leaves resumable partial bytes but cannot
  produce a verified candidate. No writes to `moby` with `ctr`.
- Per-stage logs can include cached unique Blob counts and
  `curl size_download` response-body bytes including retransmitted chunks.
  These numbers are NOT TLS total wire bytes; do not claim measured 88% savings.
- Do not prune Docker, clear the rollback image, restart the global daemon,
  or create a secondary updater to recover from a failed OCI download.
- CI Docker 29.6.2 with containerd snapshotter exercises a small synthetic
  OCI archive, import, and immutable post-verification tag. This is NOT
  yet evidence of a successful full production release update.

## Still required before turning on production

1. **DONE in isolated CI:** Docker 29.6.2 successfully imported the
   actual official v0.1.44 and v0.1.45 images by pinned Manifest Digest,
   then created and verified the immutable SHA candidate tags. The second
   release reused 8 of 9 distinct blobs and downloaded only 50,950,973
   response-body bytes (the one changed layer); a repeat used 9/9 and
   downloaded zero compressed layer bytes. Official CI acceptance:
   https://github.com/b8vipvip/mv3c/actions/runs/40691585460
2. **NOT YET DONE:** one controlled *new-version* production rollout,
   /readyz, config/API checks, rollback rehearsal, and storage-peak telemetry
   on the 40 GiB host. Retain old healthy SHA and rollback image.
3. **NOT YET DONE:** durable cache-retention bounds and safe stale-partial
   maintenance, plus a documented host-configuration opt-in review. Leave
   production OCI proxy mode disabled until these are accepted.
