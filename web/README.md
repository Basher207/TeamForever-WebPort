# RSDKv4 on the web

The engine in this repository compiled to WebAssembly, wrapped in a phone-first
page with on-screen controls. Same C++ engine as every other platform here — the
browser is just another target alongside Windows, Linux, Switch and Android.

No game assets are included. As with every other build of this decompilation,
you supply `Data.rsdk` yourself, extracted from a legally obtained copy of the
official Sonic 1 or Sonic 2 (2013 mobile) release — see the
["support the official release"](../README.md) section of the root README for
where to buy it and the extraction tutorials for Android and iOS.

**Play it:** https://basher207.github.io/TeamForever-WebPort/

---

## Hosting

[`.github/workflows/deploy-web.yml`](../.github/workflows/deploy-web.yml) builds
the engine and publishes this directory to GitHub Pages on every push that
touches `RSDKv4/`, `web/`, or the build files.

**One-time setup:** in the repository, go to **Settings → Pages → Build and
deployment** and set **Source** to **GitHub Actions**. The workflow cannot do
this for you — creating a Pages site that has never existed needs admin rights,
and the automatic `GITHUB_TOKEN` deliberately lacks them. Once the source is
set, every deploy from then on is automatic.

The Emscripten SDK is pinned to a known version rather than tracking `latest`,
and both the SDK and its compiled ports are cached, so a typical run is a couple
of minutes.

Nothing about the deployment is GitHub-specific — the output is plain static
files. To host it elsewhere, run `./web/build.sh` and upload `web/` (minus
`tools/`, `build.sh`, `serve.py` and this README).

## Build

You need the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html):

```sh
git clone https://github.com/emscripten-core/emsdk.git
./emsdk/emsdk install latest
./emsdk/emsdk activate latest
source ./emsdk/emsdk_env.sh
```

Then, from the repository root:

```sh
./web/build.sh
```

That produces `web/dist/s1fs2a.js` and `web/dist/s1fs2a.wasm` (about 1.7 MB
together). The first build also fetches SDL2, libogg and libvorbis as emscripten
ports, which takes a few minutes; later builds are incremental.

| Command | What it does |
| --- | --- |
| `./web/build.sh` | release build |
| `./web/build.sh --debug` | assertions and source maps |
| `./web/build.sh --clean` | discard objects first |
| `./web/build.sh --serve` | build, then serve on `http://localhost:8080` |

If your network allows `git` to GitHub but blocks release/archive downloads, run
`./web/tools/fetch-ports-via-git.sh` once beforehand — it populates emscripten's
port cache over git instead.

### One-file build

For hosts that will only serve a single document — a paste site, a sandboxed
viewer, an email attachment — everything can be inlined into one HTML file:

```sh
emmake make PLATFORM=Emscripten SINGLE_FILE=1 OUTDIR=web/dist-single
node web/tools/bundle-standalone.mjs           # -> web/dist-single/rsdkv4-standalone.html
```

That's about 1.8 MB with the wasm base64'd into the script, and it makes no
subresource requests at all. Add `--fragment` to emit the pieces without an
`<html>`/`<head>`/`<body>` wrapper, for hosts that supply their own shell.

It behaves identically except that there's no service worker (so no home-screen
install) and no `web/data/` to auto-load from — it always asks for the data file.
The markup, styles and scripts are read from the normal build's sources, so the
two can't drift apart.

Note that a `file://` URL won't work: browsers block IndexedDB there, so the
data file can't be stored. Serve it over http(s).

## Run it

```sh
./web/serve.py          # serves web/ on port 8080, on every interface
```

Open the printed LAN address on your phone. Any static host works — the build is
single-threaded, so it needs **no** `SharedArrayBuffer`, and therefore no COOP or
COEP headers. GitHub Pages, Netlify and a plain `nginx` all serve it as-is. The
only real requirement is that `.wasm` is served as `application/wasm`.

### Supplying the game data

On first load the page looks for the data file in three places, in order:

1. the browser's IndexedDB cache, from a previous visit
2. `web/data/Data.rsdk`, if you dropped a copy there before deploying
3. you, via a file picker

The picker takes `Data.rsdk` itself, or a `.zip`, `.apk` or `.obb` containing it
— the latter two are ZIPs wearing a different extension. That matters most on a
phone, where unpacking otherwise means leaving the browser to hunt for a file
manager. `.7z` and `.rar` are not supported; the browser has no decompressor for
them.

[`js/zip.js`](js/zip.js) reads the archive's central directory and inflates
entries with the platform's `DecompressionStream`, no library involved. Because
an APK buries its assets under arbitrary paths and gives no guarantee the file
kept its name, the search widens in stages, cheapest first:

1. an entry named `Data.rsdk`, at any depth
2. any entry with a `.rsdk` extension
3. entries over 2 MB, largest first, identified by the bytes they start with

Stage 3 reads only each candidate's first 16 bytes and then abandons the
decompression stream, so a renamed file is found without inflating an entire
archive. It stops after 8 candidates so a hostile archive can't stall the page.

Whatever it finds is cached in IndexedDB, so the picker only ever appears once
per browser. The file never leaves the device. `web/data/` is gitignored, so a
copy placed there cannot be committed by accident.

To make the page forget it: **settings → Forget the game data file**.

## Controls

Touch, keyboard and gamepad are all live at the same time — no mode switching.

**Touch.** A d-pad on the left, three face buttons on the right, START in the
middle. The d-pad is analog-ish rather than four separate hit zones: it reads the
direction of your thumb from the centre, so diagonals work and sliding from one
direction into another does not need you to lift off. Buttons behave the same
way, so rolling a thumb from B onto A is a real input.

Tap the gear to change the size, the opacity, whether they show at all, and
whether pressing them vibrates. Settings persist per browser.

In landscape the controls sit over the picture; in portrait they move to a panel
underneath it so your thumbs are not on top of the action.

**Keyboard.** Arrow keys move, <kbd>A</kbd> / <kbd>S</kbd> / <kbd>D</kbd> are the
A/B/C buttons, <kbd>Enter</kbd> is START, <kbd>Tab</kbd> is SELECT. These come
from the engine's own defaults and can be rebound in `settings.ini`.

**Gamepad.** Anything the browser exposes through the Gamepad API works.

## Installing it on a phone

The page ships a manifest and a service worker, so "Add to Home Screen" gives you
a fullscreen, landscape, offline-capable app. The engine and the page are cached
by the service worker; the data file is already in IndexedDB. After the first
successful load it runs with no network at all.

Browsers only allow installation and service workers over HTTPS (or on
`localhost`), so a plain-HTTP LAN address will play fine but will not install.

## Saves

`settings.ini`, `SData.bin`, `SGame.bin` and `UData.bin` live on an IDBFS mount at
`/rsdk/save`, which is read back out of IndexedDB before `main()` runs and flushed
to it after the engine writes. Flushes are coalesced to at most one a second, and
one is forced when the tab is hidden or closed, because a phone can discard a
backgrounded tab without warning.

Progress is per browser, per origin. Clearing site data clears your saves.

## What's different from the native builds

Two subsystems are compiled out for this target, both because the dependency has
nowhere to land in wasm:

- **Networking** (2P VS over UDP) — asio has no socket backend under wasm. The
  API is still there, implemented as no-ops, so the menus behave as though a
  connection never comes up.
- **Video playback** (Ogg Theora cutscenes) — libtheora has no emscripten port.
  Sonic 1 Forever and Sonic 2 Absolute ship no video files, so nothing in either
  game reaches this path.

Both are ordinary compile-time switches (`RETRO_USE_NETWORKING`,
`RETRO_USE_VIDEO`) rather than web-specific forks, and every other platform is
unaffected.

Everything else — the software renderer, audio, the mod loader, save data, the
dev menu — behaves as it does natively.

## How it fits together

```
web/
  index.html          page structure
  styles.css          layout; landscape overlay vs portrait panel
  js/storage.js       IndexedDB for the data file
  js/controls.js      the on-screen pad
  js/boot.js          data lookup, module startup, engine wiring
  sw.js               offline shell
  build.sh            wraps `emmake make PLATFORM=Emscripten`
  serve.py            local static server with correct MIME types
  dist/               build output (gitignored)
  data/               your Data.rsdk, if you host one (gitignored)
```

On the engine side the web-specific code is confined to
[`RSDKv4/WebPlatform.cpp`](../RSDKv4/WebPlatform.cpp), which holds the
animation-frame main loop, the save flushing, and the handful of `RSDK_*`
functions the page calls. Everything else is guarded additions to the existing
platform `#if` ladders.

The one structural change to the engine is that `RetroEngine::Run()` was split:
the body of its `while (running)` loop became `RetroEngine::StepFrame()` and the
teardown after it became `RetroEngine::Release()`. Native platforms still call
them from the same blocking loop; the browser, which cannot be blocked, calls
`StepFrame()` from `requestAnimationFrame` with a fixed-timestep accumulator so
the game still runs at 60Hz on a 120Hz display.

### Talking to the engine from the console

`window.RetroEngineModule` is the emscripten module once the game is up:

```js
const m = RetroEngineModule;
m.ccall("RSDK_SetButtonState", null, ["number", "number"], [3, 1]); // hold RIGHT
m.ccall("RSDK_GetInputHeld", "number", ["number"], [3]);            // 1
m.ccall("RSDK_RequestSaveSync", null, [], []);                      // flush saves
m.FS.readdir("/rsdk/save");
```

Button numbers are the `InputButtons` enum from
[`RSDKv4/Input.hpp`](../RSDKv4/Input.hpp): `0` UP, `1` DOWN, `2` LEFT, `3` RIGHT,
`4` A, `5` B, `6` C, `12` START.

## Troubleshooting

**"That doesn't look like an RSDKv4 data file."** The page checks for the
`RSDKv` signature at the start of the file. You want `Data.rsdk` from the game's
install folder, not a `.zip` or an installer.

**Black screen after pressing Play.** Open the console: engine messages are
prefixed `[rsdk]`. A data file that loads but has no `Data/Game/GameConfig.bin`
gets exactly this far and then stops.

**No sound.** Browsers refuse to start audio without a user gesture, which is
what the Play button is for. If you skipped it somehow, reload.

**Changes to the engine don't show up.** The service worker revalidates on every
request, so a normal reload is enough — but a hard reload
(<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>) settles it.

**Icons.** `web/icons/*.png` are generated from `icon.svg` by
`node web/tools/make-icons.mjs` (needs playwright). They're committed, so you
only need this if you change the artwork.
