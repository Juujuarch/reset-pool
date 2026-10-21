#!/usr/bin/env bash
# Boot the pool peer on the Bare runtime (same as the dex peer process).
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BARE_BIN="/home/ubuntu/dex-dl/intercom-dex-v0.1.5/peer/node_modules/bare-sidecar/prebuilds/linux-x64/bare"
export POOL_PEER_CONFIG="${POOL_PEER_CONFIG:-$DIR/pool.config.json}"
cd "$DIR"
exec "$BARE_BIN" "./pool-peer.mjs" "$@"
