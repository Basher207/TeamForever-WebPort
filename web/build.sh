#!/usr/bin/env bash
#
# Build the RSDKv4 engine to WebAssembly.
#
#   ./web/build.sh              release build into web/dist
#   ./web/build.sh --debug      assertions + source maps
#   ./web/build.sh --clean      throw away objects first
#   ./web/build.sh --serve      build, then serve web/ on http://localhost:8080
#
# Requires the Emscripten SDK on PATH (source its emsdk_env.sh first). The first
# build also downloads SDL2, libogg and libvorbis as emscripten ports, which
# takes a few minutes; every build after that is incremental.
#
set -euo pipefail

cd "$(dirname "$0")/.."

DEBUG=0
CLEAN=0
SERVE=0
JOBS="$( (command -v nproc >/dev/null && nproc) || echo 4)"

for arg in "$@"; do
	case "$arg" in
		--debug) DEBUG=1 ;;
		--clean) CLEAN=1 ;;
		--serve) SERVE=1 ;;
		-j*) JOBS="${arg#-j}" ;;
		-h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

if ! command -v emcc >/dev/null 2>&1; then
	cat >&2 <<-'EOF'
	error: emcc is not on PATH.

	Install the Emscripten SDK and activate it, for example:

	    git clone https://github.com/emscripten-core/emsdk.git
	    ./emsdk/emsdk install latest
	    ./emsdk/emsdk activate latest
	    source ./emsdk/emsdk_env.sh

	If your network blocks GitHub archive downloads but allows git, run
	./web/tools/fetch-ports-via-git.sh once before building.
	EOF
	exit 1
fi

# tinyxml2 and stb-image are submodules; a fresh clone has them empty.
if [ ! -f dependencies/all/tinyxml2/tinyxml2.cpp ]; then
	echo "== fetching submodules"
	git submodule update --init --recursive \
		dependencies/all/stb-image \
		dependencies/all/tinyxml2 \
		dependencies/all/theoraplay \
		dependencies/all/asio
fi

if [ "$CLEAN" = "1" ]; then
	echo "== cleaning"
	rm -rf obj/Emscripten web/dist
fi

mkdir -p web/dist

echo "== building (PLATFORM=Emscripten DEBUG=$DEBUG, -j$JOBS)"
emmake make PLATFORM=Emscripten DEBUG="$DEBUG" -j"$JOBS"

echo
echo "== done"
ls -lh web/dist/

cat <<'EOF'

The engine is built, but it ships no game assets. Supply the data file from your
own copy of Sonic 1 Forever or Sonic 2 Absolute in either of these ways:

  * put it at web/data/Data.rsdk and it loads automatically, or
  * open the page and choose the file when it asks - it is then cached in the
    browser and never asked for again.

EOF

if [ "$SERVE" = "1" ]; then
	exec ./web/serve.py
fi
