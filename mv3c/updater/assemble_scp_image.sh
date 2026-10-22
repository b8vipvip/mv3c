#!/usr/bin/env bash
# Runs as an unprivileged SCP-only account. Assembles a verified immutable
# Actions artifact in the fixed inbox, without any Docker or deployment access.
set -euo pipefail
umask 077
: "${1:?inbox}" "${2:?commit SHA}" "${3:?archive SHA256}" "${4:?chunk count}"
INBOX="$1"
SHA="$2"
EXPECTED="$3"
COUNT="$4"
[[ "$INBOX" == "/var/lib/mv3c-prebuilt/incoming" || "${MV3C_TEST_INBOX:-}" == "$INBOX" ]] || { echo "Unexpected inbox" >&2; exit 2; }
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid commit" >&2; exit 2; }
[[ "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || { echo "Invalid digest" >&2; exit 2; }
[[ "$COUNT" =~ ^[0-9]{1,3}$ ]] && (( 10#$COUNT >= 1 && 10#$COUNT <= 999 )) || { echo "Invalid chunk count" >&2; exit 2; }
PARTS="$INBOX/.mv3c-parts-$SHA"
ARCHIVE="$INBOX/mv3c-$SHA.tar.gz"
SIDECAR="$INBOX/mv3c-$SHA.sha256"
[[ -d "$INBOX" && -d "$PARTS" && ! -L "$PARTS" ]] || { echo "Missing parts directory" >&2; exit 2; }

chunks=()
for ((i=0; i<10#$COUNT; i++)); do
  printf -v name 'chunk-%04d' "$i"
  path="$PARTS/$name"
  [[ -f "$path" && ! -L "$path" ]] || { echo "Missing or invalid chunk $name" >&2; exit 3; }
  chunks+=("$path")
done
# No partial result is made visible to the host updater before the digest
# check succeeds. Keep the chunks if the checksum does not match.
cat "${chunks[@]}" > "$ARCHIVE.part"
actual="$(sha256sum "$ARCHIVE.part" | cut -d ' ' -f1)"
if [[ "$actual" != "$EXPECTED" ]]; then
  rm -f -- "$ARCHIVE.part"
  echo "Image archive SHA256 mismatch" >&2
  exit 4
fi
mv -f -- "$ARCHIVE.part" "$ARCHIVE"
printf '%s\n' "$EXPECTED" > "$SIDECAR.part"
mv -f -- "$SIDECAR.part" "$SIDECAR"
# Once the complete artifact is safely published, reclaim staging chunks.
rm -f -- "${chunks[@]}"
rmdir -- "$PARTS"
echo "Assembled and SHA256-verified $ARCHIVE (chunks=$COUNT)"
