#!/usr/bin/env bash
#
# Optional helper: populate emscripten's port cache from git instead of letting
# emcc download release archives over HTTPS.
#
# You do NOT need this for a normal build - `./web/build.sh` will fetch SDL2,
# libogg and libvorbis by itself the first time it runs. Use this only when the
# machine can reach github.com over git but not the archive/release download
# endpoints (corporate proxies and locked-down CI runners often look like that).
#
# Usage:
#   source /path/to/emsdk/emsdk_env.sh
#   ./web/tools/fetch-ports-via-git.sh
#   ./web/build.sh
#
set -euo pipefail

if ! command -v emcc >/dev/null 2>&1; then
	echo "error: emcc not on PATH - source your emsdk_env.sh first" >&2
	exit 1
fi

EM_ROOT="$(dirname "$(dirname "$(readlink -f "$(command -v emcc)")")")"
PORTS_DIR="${EM_CACHE:-$EM_ROOT/emscripten/cache}/ports"
if [ ! -d "$(dirname "$PORTS_DIR")" ]; then
	PORTS_DIR="$EM_ROOT/cache/ports"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# name | git repo | tag | directory name emscripten expects | url it would have fetched
PORTS=(
	"sdl2|https://github.com/libsdl-org/SDL.git|release-2.32.10|SDL-release-2.32.10|https://github.com/libsdl-org/SDL/archive/release-2.32.10.zip"
	"ogg|https://github.com/xiph/ogg.git|v1.3.5|libogg-1.3.5|https://github.com/xiph/ogg/releases/download/v1.3.5/libogg-1.3.5.zip"
	"vorbis|https://github.com/xiph/vorbis.git|v1.3.7|libvorbis-1.3.7|https://github.com/xiph/vorbis/releases/download/v1.3.7/libvorbis-1.3.7.zip"
)

for entry in "${PORTS[@]}"; do
	IFS='|' read -r name repo tag subdir url <<<"$entry"

	target="$PORTS_DIR/$name"
	marker="$target/.emscripten_url"

	if [ -f "$marker" ] && [ "$(cat "$marker")" = "$url" ]; then
		echo "== $name already in the port cache, skipping"
		continue
	fi

	echo "== fetching $name ($tag) via git"
	git clone --quiet --depth 1 --branch "$tag" "$repo" "$WORK/$name"
	rm -rf "$WORK/$name/.git"

	rm -rf "$target"
	mkdir -p "$target"
	mv "$WORK/$name" "$target/$subdir"

	# emcc treats a port as up to date when this marker matches the URL it would
	# otherwise have downloaded.
	printf '%s\n' "$url" >"$marker"
done

echo
echo "Port cache populated at $PORTS_DIR"
echo "Now run ./web/build.sh"
