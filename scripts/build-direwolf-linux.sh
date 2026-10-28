#!/usr/bin/env bash
set -euo pipefail
# Rebuild the Linux x86-64 receive-only sidecar; requires git, cmake, C compiler and ALSA headers.
root_dir=$(cd "$(dirname "$0")/.." && pwd)
work_dir=$(mktemp -d)
trap 'rm -r "$work_dir"' EXIT
git clone https://github.com/wb2osz/direwolf.git "$work_dir/source"
git -C "$work_dir/source" checkout eda1383f5fa9d8ba3cb27f99db1d2c79494404c9
git -C "$work_dir/source" apply "$root_dir/third-party/direwolf/receive-only.patch"
cmake -S "$work_dir/source" -B "$work_dir/build" -DCMAKE_BUILD_TYPE=Release -DOPTIONAL_DNSSD=OFF -DCMAKE_DISABLE_FIND_PACKAGE_GPSD=TRUE -DCMAKE_DISABLE_FIND_PACKAGE_hamlib=TRUE -DCMAKE_DISABLE_FIND_PACKAGE_udev=TRUE
cmake --build "$work_dir/build" --target direwolf -j 4
install -m 755 "$work_dir/build/src/direwolf" "$root_dir/src-tauri/resources/direwolf-linux-x86_64"
