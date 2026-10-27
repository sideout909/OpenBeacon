#!/bin/sh
set -eu
# Official go-pmtiles release, pinned and verified before replacing the bundled tool.
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
curl -fL https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Linux_x86_64.tar.gz -o "$tmp_dir/pmtiles.tar.gz"
tar -xzf "$tmp_dir/pmtiles.tar.gz" -C "$tmp_dir" pmtiles
printf '%s  %s\n' a7e9ae10184d109c83f456ccdf6df4f3e2a64ba6cf69d9ed0f9f1840305055c1 "$tmp_dir/pmtiles" | sha256sum -c -
install -m 755 "$tmp_dir/pmtiles" "$(dirname "$0")/../src-tauri/resources/pmtiles-linux-x86_64"
