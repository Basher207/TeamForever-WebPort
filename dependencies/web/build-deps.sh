#!/bin/sh
# Builds the web port's library dependencies (SDL2, libogg, libvorbis) with Emscripten
# from their git repositories, installing into dependencies/web/prefix.
#
# Normally you don't need this: the default web build fetches the same libraries through
# Emscripten's ports system (-sUSE_SDL=2 etc). Use this script when that fetch isn't
# possible (offline machines, restricted networks), then build the engine with:
#
#   make PLATFORM=Emscripten WEB_DEPS=local
#
# Requires: emsdk environment (emcc/emcmake in PATH), cmake, git.

set -e

cd "$(dirname "$0")"
PREFIX="$(pwd)/prefix"
JOBS="${JOBS:-4}"

SDL2_TAG="release-2.32.6"
OGG_TAG="v1.3.6"
VORBIS_TAG="v1.3.7"

clone() { # repo url, tag, dir
    if [ ! -d "$3" ]; then
        git clone --depth 1 --branch "$2" "$1" "$3"
    fi
}

clone https://github.com/libsdl-org/SDL.git   "$SDL2_TAG"   SDL
clone https://github.com/xiph/ogg.git         "$OGG_TAG"    ogg
clone https://github.com/xiph/vorbis.git      "$VORBIS_TAG" vorbis

build() { # dir, extra cmake args...
    dir="$1"; shift
    emcmake cmake -S "$dir" -B "$dir/build-web" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DCMAKE_PREFIX_PATH="$PREFIX" \
        -DBUILD_SHARED_LIBS=OFF \
        "$@"
    cmake --build "$dir/build-web" -j "$JOBS"
    cmake --install "$dir/build-web"
}

build ogg    -DINSTALL_DOCS=OFF
build vorbis
build SDL    -DSDL_STATIC=ON -DSDL_SHARED=OFF -DSDL_TEST=OFF

echo ""
echo "Web dependencies installed to $PREFIX"
echo "Build the engine with: make PLATFORM=Emscripten WEB_DEPS=local"
