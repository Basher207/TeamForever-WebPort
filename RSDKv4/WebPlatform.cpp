#include "RetroEngine.hpp"

#if RETRO_PLATFORM == RETRO_EMSCRIPTEN

#include <emscripten.h>
#include <emscripten/html5.h>

int webInputHeld[INPUT_BUTTONCOUNT];

// ============================================================================
// Persistent storage
// ============================================================================

// The page mounts IDBFS on RETRO_WEB_SAVE_PATH before main() runs and populates
// it from IndexedDB. Writes only reach IndexedDB when FS.syncfs() is called, so
// the engine flags itself dirty on every save and we push one flush per second
// at most (a sync walks the whole mount, so doing it per write would be waste).
static bool webSaveDirty   = false;
static int webSaveCooldown = 0;
#define WEB_SAVE_COOLDOWN_FRAMES (60)

void FlagWebSaveDirty() { webSaveDirty = true; }

// syncfs is asynchronous, and running two at once against the same mount is not
// safe, so overlapping requests are coalesced here rather than dropped: a
// request that arrives mid-sync sets a pending flag and re-runs on completion.
// Dropping it instead would silently lose whatever the engine had just written.
EM_JS(void, WebSyncSavesJS, (), {
    var run = function() {
        Module["__saveSyncInFlight"] = true;
        Module["__saveSyncPending"]  = false;

        FS.syncfs(false, function(err) {
            Module["__saveSyncInFlight"] = false;

            if (err)
                console.error("[RSDKv4] failed to persist save data:", err);
            else if (Module["onSaveSynced"])
                Module["onSaveSynced"]();

            if (Module["__saveSyncPending"])
                run();
        });
    };

    if (Module["__saveSyncInFlight"])
        Module["__saveSyncPending"] = true;
    else
        run();
});

static void WebFlushSaves()
{
    webSaveDirty    = false;
    webSaveCooldown = WEB_SAVE_COOLDOWN_FRAMES;
    WebSyncSavesJS();
}

// ============================================================================
// Input bridge
// ============================================================================

bool WebInputActive()
{
    for (int i = 0; i < INPUT_BUTTONCOUNT; ++i) {
        if (webInputHeld[i])
            return true;
    }
    return false;
}

// ============================================================================
// Main loop
// ============================================================================

// requestAnimationFrame fires at the display's refresh rate, which is 120Hz or
// 90Hz on plenty of phones, but RSDKv4 logic is locked to Engine.refreshRate.
// Accumulate real time and step the engine only when a whole frame is due.
static double webFrameAccumulator = 0.0;
static double webLastTime         = -1.0;
static int webFrameCount          = 0;

// Never run more than this many logic steps in one animation frame; without a
// cap, a long stall (backgrounded tab, slow load) would try to replay every
// missed frame at once and stall even harder.
#define WEB_MAX_CATCHUP_FRAMES (4)

static void WebFrame()
{
    if (!Engine.running) {
        emscripten_cancel_main_loop();

        // Release() writes settings out, so flush after it rather than before -
        // no further frames will run to notice the dirty flag.
        Engine.Release();
        WebSyncSavesJS();

        EM_ASM({
            if (Module["onEngineExit"])
                Module["onEngineExit"]();
        });
        return;
    }

    const double now = emscripten_get_now() / 1000.0;
    if (webLastTime < 0.0)
        webLastTime = now;

    double elapsed = now - webLastTime;
    webLastTime    = now;

    // A tab that was hidden or a stage that took a long time to load can hand us
    // a huge delta; clamp it so we never try to catch up across seconds of time.
    const double frameStep = 1.0 / (Engine.refreshRate > 0 ? Engine.refreshRate : 60);
    if (elapsed > frameStep * WEB_MAX_CATCHUP_FRAMES)
        elapsed = frameStep * WEB_MAX_CATCHUP_FRAMES;

    webFrameAccumulator += elapsed;

    Engine.deltaTime = frameStep;

    int steps = 0;
    while (webFrameAccumulator >= frameStep && steps < WEB_MAX_CATCHUP_FRAMES) {
        webFrameAccumulator -= frameStep;
        ++steps;
        ++webFrameCount;

        Engine.StepFrame();

        if (!Engine.running)
            break;
    }

    // Guard against drifting forever behind on a device that simply can't keep
    // up: once we've spent the catch-up budget, drop the leftover time.
    if (webFrameAccumulator > frameStep)
        webFrameAccumulator = 0.0;

    if (webSaveCooldown > 0)
        --webSaveCooldown;

    if (webSaveDirty && webSaveCooldown <= 0)
        WebFlushSaves();
}

void RunWebMainLoop()
{
    webLastTime         = -1.0;
    webFrameAccumulator = 0.0;

    EM_ASM({
        if (Module["onEngineStarted"])
            Module["onEngineStarted"]();
    });

    // fps = 0 -> drive from requestAnimationFrame; simulate_infinite_loop = 1 ->
    // unwind out of main() so the browser gets control back between frames.
    emscripten_set_main_loop(WebFrame, 0, 1);
}

// ============================================================================
// Exports called from the page
// ============================================================================

extern "C" {

// Press/release one of the InputButtons values from the on-screen controls.
EMSCRIPTEN_KEEPALIVE void RSDK_SetButtonState(int button, int held)
{
    if (button < 0 || button >= INPUT_BUTTONCOUNT)
        return;

    webInputHeld[button] = held ? 1 : 0;
}

// Release everything. Used when the controls lose their touches (page hidden,
// gesture cancelled) so Sonic doesn't keep running off-screen.
EMSCRIPTEN_KEEPALIVE void RSDK_ClearButtonStates()
{
    for (int i = 0; i < INPUT_BUTTONCOUNT; ++i) webInputHeld[i] = 0;
}

// Suspend/resume the game when the tab is hidden. Mirrors what the desktop
// build does on focus loss.
EMSCRIPTEN_KEEPALIVE void RSDK_SetFocused(int focused)
{
    Engine.hasFocus = focused != 0;

    if (!focused) {
        RSDK_ClearButtonStates();
        if (!(Engine.focusState & 1))
            Engine.focusState = PauseSound() ? 3 : 1;
    }
    else {
        if (Engine.focusState & 2)
            ResumeSound();
        Engine.focusState = 0;

        // Time passed while we were away; don't try to replay it.
        webLastTime         = -1.0;
        webFrameAccumulator = 0.0;
    }
}

// A browser is the one target that cannot know at compile time whether it is a
// phone or a desktop, and the game's scripts branch on this: data from the 2013
// mobile releases reaches its menus through touch rects and has no button path
// at all, so a build reporting STANDARD leaves them unreachable no matter what
// the input bridge does. Reloading the scene re-runs the startup events, which
// is where objects decide what to draw for the device they think they are on.
EMSCRIPTEN_KEEPALIVE void RSDK_SetDeviceType(int mobile)
{
    int wanted = mobile ? RETRO_MOBILE : RETRO_STANDARD;
    if (Engine.gameDeviceType == wanted)
        return;

    Engine.gameDeviceType = wanted;
    Engine.gamePlatform   = wanted == RETRO_MOBILE ? "MOBILE" : "STANDARD";

    if (Engine.initialised)
        stageMode = STAGEMODE_LOAD;
}

// Ask the engine to flush save data now (e.g. on pagehide).
EMSCRIPTEN_KEEPALIVE void RSDK_RequestSaveSync()
{
    webSaveDirty    = true;
    webSaveCooldown = 0;
}

// How many game frames have actually been stepped. The page uses this to tell
// "the engine is running" apart from "the engine started and then wedged".
EMSCRIPTEN_KEEPALIVE int RSDK_GetFrameCount() { return webFrameCount; }

// Whether the last rendered frame was a single flat colour.
//
// The page needs to know whether anything is actually visible, and it cannot ask
// the canvas: SDL owns the drawing context, so there is no second context to
// read pixels back through. Sampling the software framebuffer here answers the
// same question far more cheaply than a readback would.
EMSCRIPTEN_KEEPALIVE int RSDK_ScreenIsBlank()
{
#if RETRO_SOFTWARE_RENDER
    if (!Engine.frameBuffer)
        return 1;

    const int stride = 7; // coprime with the line size, so rows don't sample the same columns
    const int total  = GFX_LINESIZE * SCREEN_YSIZE;
    if (total <= 0)
        return 1;

    ushort first = Engine.frameBuffer[0];
    for (int i = stride; i < total; i += stride) {
        if (Engine.frameBuffer[i] != first)
            return 0;
    }
#endif
    return 1;
}

// A snapshot of the state that explains a black screen, as JSON. Cheaper to read
// than a log, and unlike PrintLog it does not depend on debug mode being on.
EMSCRIPTEN_KEEPALIVE const char *RSDK_GetStatusJSON()
{
    static char buffer[640];

    // "sent" is what the page pushed in, "held" is what the engine made of it
    // after ProcessInput. They are separate because a button that arrives but
    // never lands looks exactly like a button that never arrived, and the two
    // have nothing in common to fix.
    int sent = 0, held = 0;
    for (int i = 0; i < INPUT_BUTTONCOUNT && i < 31; ++i) {
        if (webInputHeld[i])
            sent |= 1 << i;
        if (inputDevice[i].hold)
            held |= 1 << i;
    }

    snprintf(buffer, sizeof(buffer),
             "{\"running\":%d,\"initialised\":%d,\"frames\":%d,\"blank\":%d,"
             "\"gameType\":%d,\"gameMode\":%d,\"usingDataFile\":%d,\"usingBytecode\":%d,"
             "\"screen\":\"%dx%d\",\"stageMode\":%d,\"stageList\":%d,\"stagePos\":%d,"
             "\"stage\":\"%s\",\"audio\":%d,\"sent\":%d,\"held\":%d,\"inputType\":%d,"
             "\"deviceType\":%d,\"scriptErrors\":%d,\"reloads\":%d}",
             Engine.running ? 1 : 0, Engine.initialised ? 1 : 0, webFrameCount, RSDK_ScreenIsBlank(),
             Engine.gameType, Engine.gameMode, Engine.usingDataFile ? 1 : 0, Engine.usingBytecode ? 1 : 0,
             SCREEN_XSIZE, SCREEN_YSIZE, stageMode, activeStageList, stageListPosition,
             currentStageFolder, audioEnabled ? 1 : 0, sent, held, inputType,
             Engine.gameDeviceType, scriptRangeErrors, reloadStreak);

    return buffer;
}

// Turns on the engine's own logging, which is off by default. Wired to ?debug=1
// so a black screen can be investigated without a rebuild.
EMSCRIPTEN_KEEPALIVE void RSDK_SetDebugMode(int enabled)
{
    engineDebugMode = enabled != 0;
    Engine.devMenu  = enabled != 0;
}

// Same, but survives InitUserdata reading settings.ini over the top, so it can
// be set from preRun and catch the logging from device and file setup. Those
// lines run before main() gets anywhere near an exported function, and they are
// the ones that say why something came up disabled.
EMSCRIPTEN_KEEPALIVE void RSDK_SetForceLog(int enabled) { forceDebugLog = enabled != 0; }

// Logs every script opcode as it starts. ProcessScript is one enormous switch,
// so a crash inside it produces a stack that stops at its door; the last opcode
// to begin is the only thing that says which of several hundred cases was live.
EMSCRIPTEN_KEEPALIVE void RSDK_SetScriptTrace(int enabled) { scriptTraceEnabled = enabled != 0; }

// Restrict the trace to one object type. A stage at rest still runs every
// object's main and draw event sixty times a second, so an unfiltered trace
// buries the one event worth reading. -1 traces everything.
EMSCRIPTEN_KEEPALIVE void RSDK_SetTraceObject(int objectType) { scriptTraceObject = objectType; }

// Whether the engine currently considers a button held, after the keyboard,
// gamepad and touch sources have been merged. Exposed so the page (and the
// browser console) can confirm input is actually landing.
EMSCRIPTEN_KEEPALIVE int RSDK_GetInputHeld(int button)
{
    if (button < 0 || button >= INPUT_BUTTONCOUNT)
        return 0;

    return inputDevice[button].hold ? 1 : 0;
}

// 1 = Sonic 1, 2 = Sonic 2, 0 = unknown. Lets the page set its title/icon.
EMSCRIPTEN_KEEPALIVE int RSDK_GetGameType() { return Engine.gameType; }

// The game's own render width, so the page can size the canvas to match.
EMSCRIPTEN_KEEPALIVE int RSDK_GetScreenWidth() { return SCREEN_XSIZE; }
EMSCRIPTEN_KEEPALIVE int RSDK_GetScreenHeight() { return SCREEN_YSIZE; }

EMSCRIPTEN_KEEPALIVE int RSDK_IsRunning() { return Engine.running ? 1 : 0; }

} //! extern "C"

#endif //! RETRO_PLATFORM == RETRO_EMSCRIPTEN
