# Resumable GHCR proxy blob staging (development stage)

The production updater remains **unchanged**. This module is an isolated, offline-testable
building block, **not** a deployable replacement for the attested Docker image path.
Do not enable `MV3C_OCI_LAYER_TRANSPORT=enabled` based on this module alone.

## Why this exists

On the 40 GiB production host, direct GHCR transfers are slow and a containerd
client pull through the local SOCKS proxy stopped mid-layer with an unexpected
EOF. A curl-managed stage can resume the **exact** official compressed blob,
rather than starting a 290 MB download from zero each time.

`oci_proxy_blob.stage_blob(stage, digest, size, proxy=...)`:

- accepts only strict SHA256 digests and attested positive byte sizes;
- requires a loopback proxy, never prints a GHCR token in argv;
- resumes a `sha256.part` file using curl's HTTP Range continuation;
- preserves resumable partials after transfer interruption;
- verifies **both** final size and SHA256 before atomic promotion;
- preserves a 2 GiB minimum disk reserve, refuses symlinks;
- emits progress *counters* but not a token or untrusted redirect URL;
- NEVER touches containerd's `moby` namespace, Docker daemon, image tags,
  running containers, or the canonical MongoDB updater queue.

## Not yet implemented or proven

- Deriving the exact layer set and sizes from the **protected release manifest**,
  including multi-arch handling and GHCR authorization renewal.
- Building and importing a valid OCI image **through the supported Docker API**
  while retaining compressed-layer reuse and verifying Docker's final repo
  digest, config, and image ID.
- Host proof of cache hit vs actual wire bytes. Durable byte differences are
  *not* a measurement of network traffic: reconnect attempts can retransmit.
- Controlled end-to-end upgrade, rollback safety and crash recovery in the
  one canonical updater.

No production caller should be added until those components and an isolated
end-to-end acceptance test exist. The existing signed GitHub Release archive
remains the trusted production fallback.
