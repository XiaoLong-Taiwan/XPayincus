#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"
for arch in amd64 arm64; do
  require_new "$DIST_DIR/xpayincus-agent-${VERSION}-linux-${arch}"
  require_new "$DIST_DIR/xpayincus-agent-${VERSION}-linux-${arch}.gz"
done
require_new "$DIST_DIR/manifest.json"
STAGING="$(mktemp -d "$DIST_DIR/.agent.XXXXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT
for arch in amd64 arm64; do
  output="$STAGING/xpayincus-agent-${VERSION}-linux-${arch}"
  (
    cd "$ROOT_DIR/XPayincus-Agent"
    CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -buildvcs=false \
      -gcflags 'all=-l' -ldflags "-s -w -X main.version=${VERSION}" -o "$output" ./cmd/incudal-agent
  )
  chmod +x "$output"
  gzip -9 -c "$output" > "$output.gz"
done
STAGING="$STAGING" node --input-type=module <<'NODE'
import fs from 'node:fs'
import crypto from 'node:crypto'
const version = process.env.VERSION
const files = {}
for (const arch of ['amd64', 'arm64']) {
  const name = `xpayincus-agent-${version}-linux-${arch}.gz`
  const file = `${process.env.STAGING}/${name}`
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  files[`linux-${arch}`] = { name, sha256: hash.digest('hex'), size: fs.statSync(file).size, gzip: true }
}
fs.writeFileSync(`${process.env.STAGING}/manifest.json`, JSON.stringify({ version, generatedAt: new Date().toISOString(), files }, null, 2) + '\n', { flag: 'wx' })
NODE
for file in "$STAGING"/*; do publish_file "$file" "$DIST_DIR/$(basename "$file")"; done
