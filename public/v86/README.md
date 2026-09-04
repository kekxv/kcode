# Verified v86 assets

This directory contains only the manifest and reproducible asset recipes in Git.
Generated binaries are ignored: run `npm run assets:sync`,
`./scripts/build-alpine-guest.sh`, and `node scripts/build-v86-snapshot.mjs`.

`npm run assets:verify` is fail-closed. It checks the pinned v86 package and
Alpine OCI metadata, the complete APK lock digest, every asset's SHA-256, the
absence of unlisted binaries, and snapshot compatibility. Do not hand-copy an
asset into this directory.
