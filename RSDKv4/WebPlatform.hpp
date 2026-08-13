#ifndef WEBPLATFORM_HPP
#define WEBPLATFORM_HPP

#if RETRO_PLATFORM == RETRO_EMSCRIPTEN

// ============================================================================
// Emscripten / browser platform layer.
//
// The browser owns the event loop and cannot be blocked, so the engine's main
// loop is driven one frame at a time from requestAnimationFrame. This file also
// carries the small bridge the page's on-screen controls talk to, and the
// bookkeeping that flushes save data out to IndexedDB.
// ============================================================================

// Button states pushed in by the page's touch controls. Merged with the
// keyboard/gamepad state in ProcessInput() so all three work at once.
extern int webInputHeld[INPUT_BUTTONCOUNT];

// True while the page's touch controls are being held, used to keep the engine
// in keyboard-input mode instead of letting an idle gamepad steal focus.
bool WebInputActive();

// Installs the animation-frame callback. Never returns.
void RunWebMainLoop();

// Marks the persistent (IDBFS) mount as needing a flush. Called after the
// engine writes settings or save data; the actual sync is coalesced and issued
// from the main loop so a save never stalls a frame.
void FlagWebSaveDirty();

#endif //! RETRO_PLATFORM == RETRO_EMSCRIPTEN

#endif // !WEBPLATFORM_HPP
