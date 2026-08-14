/* ==========================================================================
   Boot sequence.

   1. find the game data file  (IndexedDB cache -> server -> file picker)
   2. wait for a tap, which is what lets the browser start audio at all
   3. instantiate the wasm module, with the data file and an IDBFS save mount
      already in place before main() runs
   4. hand the on-screen controls a channel into the engine
   ========================================================================== */

(() => {
	"use strict";

	// Stamped onto asset URLs at deploy time so a cached copy of this file can
	// never be paired with a differently-aged engine build.
	const BUILD = typeof window.__BUILD__ === "string" ? window.__BUILD__ : "";
	const bust = url => (BUILD ? url + (url.includes("?") ? "&" : "?") + "v=" + BUILD : url);

	// ?safe=1 loads the heap-checked build, which reports the exact access that
	// goes out of bounds instead of trapping somewhere further downstream. It is
	// far too slow to play; it is for finding a bug once.
	const params = new URLSearchParams(location.search);
	const SAFE_BUILD = params.get("safe") === "1";

	// Which opcode list a data file needs is a property of the file, not of the
	// engine, and nothing in the container says which - so there is a build per
	// list and no way to pick automatically. ?rev= selects between them.
	//
	//   2  the default, the latest RSDKv4 list
	//   0  the earliest Sonic 1 list
	//   1nc  the earliest Sonic 2 list, minus SetClassicFade and ClassicTint
	//
	// 1nc exists because those two opcodes are unconditional in the engine's list
	// but absent from older data, which makes everything above each one decode a
	// place too low. It is the only combination under which a Title.bin whose
	// bytecode reads 75, 83 and 132 decodes as DrawRect, SetMusicTrack and
	// SetTableValue rather than as LoadStage, ProcessAnimation and nonsense.
	const REV_BUILDS = {
		"2":   "dist",
		"0":   "dist-rev0",
		"1nc": "dist-rev1nc",
	};
	// Remembered, because the list a file needs is a property of that file and so
	// does not change between visits, and because the query string is exactly what
	// gets lost when the page is launched from a home screen shortcut - which is
	// how it will mostly be launched. An explicit ?rev= still wins, so a link
	// works regardless of what the device happens to remember.
	// The game's scripts branch on this to decide whether their menus answer to
	// buttons or to touches, and a browser is the one target that cannot know at
	// compile time which it is running on. Data from the 2013 mobile releases has
	// no button path at all, so on a touch device this has to say MOBILE or the
	// title screen ignores every button no matter how well the input arrives.
	const DEVICE_KEY = "rsdkv4:deviceType";
	let deviceStored = null;
	try { deviceStored = localStorage.getItem(DEVICE_KEY); } catch (e) { /* private mode */ }

	const deviceParam = params.get("device");
	const MOBILE = ["mobile", "standard"].includes(deviceParam) ? deviceParam === "mobile"
	             : ["mobile", "standard"].includes(deviceStored) ? deviceStored === "mobile"
	             : (navigator.maxTouchPoints || 0) > 0;
	try { localStorage.setItem(DEVICE_KEY, MOBILE ? "mobile" : "standard"); } catch (e) { /* private mode */ }

	const REV_KEY = "rsdkv4:opcodeList";
	let revStored = null;
	try { revStored = localStorage.getItem(REV_KEY); } catch (e) { /* private mode */ }

	const REV = REV_BUILDS[params.get("rev")] ? params.get("rev")
	          : REV_BUILDS[revStored]         ? revStored
	          :                                 "2";
	try { localStorage.setItem(REV_KEY, REV); } catch (e) { /* private mode */ }

	// Every revision has a heap-checked twin, so ?rev=X&safe=1 always means what
	// it says. An earlier version silently fell back to the default heap-checked
	// build, which looks exactly like a revision having been tried and not helped.
	const WASM_DIR = REV_BUILDS[REV] + (SAFE_BUILD ? "-safe/" : "/");
	const WASM_LOADER = WASM_DIR + "s1fs2a.js";
	const DATA_URL = "data/Data.rsdk";      // optional: drop your own copy here
	const GAME_ROOT = "/rsdk";
	const SAVE_ROOT = "/rsdk/save";

	const ui = {
		boot: document.getElementById("boot"),
		title: document.getElementById("boot-title"),
		status: document.getElementById("boot-status"),
		progress: document.getElementById("boot-progress"),
		bar: document.getElementById("boot-bar"),
		picker: document.getElementById("boot-picker"),
		file: document.getElementById("file-input"),
		play: document.getElementById("boot-play"),
		error: document.getElementById("boot-error"),
		canvas: document.getElementById("canvas"),
	};

	let dataBytes = null;
	let engine = null;
	let savesPersist = true;
	let debugRequested = false;

	/* ---------------------------  small helpers  ------------------------ */

	const setStatus = text => {
		ui.status.textContent = text;
		RetroLog.info(text);
	};

	function setProgress(fraction) {
		if (fraction === null) {
			ui.progress.classList.add("hidden");
			return;
		}
		ui.progress.classList.remove("hidden");
		ui.bar.style.width = Math.max(0, Math.min(1, fraction)) * 100 + "%";
	}

	function fail(message, err) {
		if (err) console.error("[boot]", err);
		RetroLog.error(message.replace(/\n/g, " ") + (err ? " | " + err : ""));
		RetroLog.show(true);
		ui.error.textContent = message + (err ? "\n\n" + err : "");
		ui.error.classList.remove("hidden");
		setProgress(null);
	}

	const formatMB = bytes => (bytes / (1024 * 1024)).toFixed(1) + " MB";

	/* ------------------------  data file acquisition  ------------------- */

	/**
	 * Try to pull the data file off the server. Absent is the normal case - the
	 * repository ships no game assets - so a 404 is not an error, just a cue to
	 * ask the player for their own copy.
	 */
	async function fetchDataFile() {
		// The single-file build is one document with nothing hosted beside it, so
		// there is no data/ directory to probe - asking would only log a 404.
		if (engineIsInlined()) return null;

		let response;
		try {
			response = await fetch(DATA_URL, { cache: "force-cache" });
		} catch {
			return null;               // offline or blocked; fall through to the picker
		}

		if (!response.ok) return null;

		// A misconfigured static host answers 200 with an HTML error page; RSDK
		// files start with a 6-byte "RSDKv" signature, so check before committing.
		const total = Number(response.headers.get("content-length")) || 0;
		const reader = response.body && response.body.getReader ? response.body.getReader() : null;

		if (!reader) {
			const buf = new Uint8Array(await response.arrayBuffer());
			return looksLikeRSDK(buf) ? buf : null;
		}

		const chunks = [];
		let received = 0;

		setStatus("Downloading game data…");
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			received += value.length;
			setProgress(total ? received / total : null);
			if (!total) setStatus("Downloading game data… " + formatMB(received));
		}
		setProgress(null);

		const bytes = new Uint8Array(received);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }

		return looksLikeRSDK(bytes) ? bytes : null;
	}

	function looksLikeRSDK(bytes) {
		// RSDKv4 containers begin with the ASCII tag "RSDKv" followed by a version
		// byte. Anything else is a wrong file (or an HTML 404 page).
		if (!bytes || bytes.length < 6) return false;
		return bytes[0] === 0x52 && bytes[1] === 0x53 && bytes[2] === 0x44 && bytes[3] === 0x4B && bytes[4] === 0x76;
	}

	function readPickedFile(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(reader.error || new Error("could not read the file"));
			reader.onprogress = ev => { if (ev.lengthComputable) setProgress(ev.loaded / ev.total); };
			reader.onload = () => resolve(new Uint8Array(reader.result));
			reader.readAsArrayBuffer(file);
		});
	}

	function showPicker(message) {
		setStatus(message);
		ui.picker.classList.remove("hidden");
		ui.play.classList.add("hidden");
	}

	function showPlay(message) {
		setStatus(message);
		ui.picker.classList.add("hidden");
		ui.play.classList.remove("hidden");
	}

	async function acquireData() {
		setStatus("Looking for game data…");

		const cached = await RetroStorage.loadDataFile();
		if (looksLikeRSDK(cached)) {
			dataBytes = cached;
			showPlay("Game data ready · " + formatMB(cached.length));
			return;
		}

		const fetched = await fetchDataFile();
		if (fetched) {
			dataBytes = fetched;
			setStatus("Saving game data for next time…");
			await RetroStorage.saveDataFile(fetched);
			await RetroStorage.requestPersistence();
			showPlay("Game data ready · " + formatMB(fetched.length));
			return;
		}

		showPicker("No game data found on this device.");
	}

	ui.file.addEventListener("change", async () => {
		const file = ui.file.files && ui.file.files[0];
		if (!file) return;

		ui.error.classList.add("hidden");
		setStatus("Reading " + file.name + "…");

		try {
			let bytes = await readPickedFile(file);
			setProgress(null);

			// Downloads arrive as archives, and unzipping on a phone means leaving
			// the browser to find a file manager. Dig the data file out here
			// instead so the file can be picked exactly as it was downloaded.
			// .apk and .obb are ZIPs too, so they come through this same path.
			if (!looksLikeRSDK(bytes) && RetroZip.looksLikeZip(bytes)) {
				setStatus("Looking inside " + file.name + "…");
				try {
					const found = await RetroZip.findDataFile(bytes, looksLikeRSDK);
					if (!found) {
						fail("Couldn't find any game data in that file.\n" +
						     "It should contain Data.rsdk. If it holds another archive inside it, " +
						     "you'll need to extract that one first.");
						return;
					}
					console.log(`[boot] using ${found.name} from ${file.name}`);
					// Full path, not just the base name: which entry was chosen out
					// of an archive matters when the pick turns out to be wrong.
					setStatus(`Found ${found.name} (${(found.bytes.length / 1048576).toFixed(1)} MB)`);
					bytes = found.bytes;
				} catch (err) {
					fail("Couldn't read that file as an archive.\n" +
					     ".zip, .apk and .obb work — for .7z or .rar you'll need to extract it yourself.", err);
					return;
				}
			}

			if (!looksLikeRSDK(bytes)) {
				fail("That doesn't look like an RSDKv4 data file.\n" +
				     "You're after Data.rsdk from your game's folder, or a .zip containing it.");
				return;
			}

			dataBytes = bytes;
			setStatus("Saving game data for next time…");
			await RetroStorage.saveDataFile(bytes);
			await RetroStorage.requestPersistence();
			showPlay("Game data ready · " + formatMB(bytes.length));
		} catch (err) {
			setProgress(null);
			fail("Could not read that file.", err);
		}
	});

	/**
	 * Drop the cached data file and start over. Reloading is the honest way to
	 * do it: the engine has the old data mapped into its filesystem and cannot
	 * be handed a different one while it is running.
	 */
	async function changeDataFile() {
		RetroLog.info("clearing the cached game data…");
		await RetroStorage.forgetDataFile();
		// The remembered opcode list belongs to the file being forgotten, so a
		// different file would otherwise inherit a choice made for its predecessor
		// and fail in a way that looks nothing like a wrong setting.
		try { localStorage.removeItem(REV_KEY); } catch (e) { /* private mode */ }
		location.reload();
	}

	document.getElementById("btn-forget").addEventListener("click", changeDataFile);

	// A button rather than a documented URL parameter: editing a query string on
	// a phone is miserable, and a stale cached page can hand back a boot.js that
	// has never heard of the parameter, which looks exactly like the flag being
	// ignored. The button always comes from the same file that reads it.
	// Which opcode list a data file needs is a property of the file, and
	// nothing in the container says which. So it is a cycle rather than a
	// setting: data from the original Sonic 1 release wants rev 0, the Forever
	// projects' own data wants the default.
	document.getElementById("log-rev").addEventListener("click", () => {
		const url = new URL(location.href);

		// Cycles rather than toggles, now that there are three. Ordered so the
		// most likely alternative comes first from the default.
		const order = ["2", "1nc", "0"];
		const next = order[(order.indexOf(REV) + 1) % order.length];

		if (next === "2") url.searchParams.delete("rev");
		else url.searchParams.set("rev", next);

		url.searchParams.set("r", String(Date.now()));
		location.replace(url.toString());
	});

	// Same reasoning as the opcode list: which one a data file wants is a property
	// of the file, the container does not say, and editing a query string on a
	// phone is miserable.
	document.getElementById("log-device").addEventListener("click", () => {
		const url = new URL(location.href);
		url.searchParams.set("device", MOBILE ? "standard" : "mobile");
		url.searchParams.set("r", String(Date.now()));
		location.replace(url.toString());
	});

	document.getElementById("log-safe").addEventListener("click", () => {
		const url = new URL(location.href);

		if (SAFE_BUILD) url.searchParams.delete("safe");
		else url.searchParams.set("safe", "1");

		// Defeat any cached copy of the page itself, not just of its assets.
		url.searchParams.set("r", String(Date.now()));
		location.replace(url.toString());
	});

	// The same action from the log panel. Duplicated on purpose: the log is what
	// is on screen when the game will not start, and the settings button behind
	// it is exactly what a stuck player cannot reach.
	document.getElementById("log-change").addEventListener("click", changeDataFile);

	/* ---------------------------  engine start  ------------------------- */

	function loadScript(src) {
		return new Promise((resolve, reject) => {
			const el = document.createElement("script");
			el.src = src;
			el.onload = resolve;
			el.onerror = () => reject(new Error("could not load " + src));
			document.head.appendChild(el);
		});
	}

	function buildModuleConfig() {
		return {
			canvas: ui.canvas,
			arguments: [],
			locateFile: path => bust(WASM_DIR + path),

			// The engine's own stdout/stderr, mirrored onto the screen: on a phone
			// the console is unreachable, and this is where the interesting
			// failures announce themselves.
			print: (...args) => { console.log("[rsdk]", ...args); RetroLog.info("rsdk: " + args.join(" ")); },
			printErr: (...args) => { console.warn("[rsdk]", ...args); RetroLog.warn("rsdk: " + args.join(" ")); },

			// Emscripten hands each preRun callback the module itself; with
			// MODULARIZE there is no global Module to reach for instead.
			preRun: [function (mod) {
				const { FS, IDBFS } = mod;

				FS.mkdir(GAME_ROOT);

				// The data file: plain in-memory, written straight from the bytes we
				// already hold. Drop our reference afterwards so the copy in the
				// wasm heap is the only one left.
				FS.writeFile(GAME_ROOT + "/Data.rsdk", dataBytes);
				dataBytes = null;

				// The mod loader scans this directory; without it, it logs an error.
				FS.mkdir(GAME_ROOT + "/mods");

				// Saves and settings: IDBFS, populated before main() runs.
				FS.mkdir(SAVE_ROOT);

				// Some contexts have no usable IndexedDB at all - a sandboxed
				// frame with an opaque origin, private mode on older browsers.
				// The game should still be playable there, just without saves,
				// so fall back to the plain in-memory filesystem.
				try {
					FS.mount(IDBFS, {}, SAVE_ROOT);
				} catch (err) {
					console.warn("[boot] no persistent storage here; progress won't be kept:", err);
					savesPersist = false;
					return;
				}

				// Hold main() back until IndexedDB has been read back into the
				// mount, otherwise the engine writes a fresh settings.ini over
				// whatever the player already had.
				mod.addRunDependency("rsdk-save-load");
				FS.syncfs(true, err => {
					if (err) {
						console.warn("[boot] could not restore saved data:", err);
						savesPersist = false;
					}
					mod.removeRunDependency("rsdk-save-load");
				});
			}],

			// After the wasm runtime is up but still before main() - the only
			// window where an export may legally be called and the engine's own
			// device and file setup has not run yet. preRun is too early: calling
			// an export there aborts outright under ASSERTIONS.
			// Not an arrow function: emscripten invokes this as a method of the
			// module, and `this` is the only handle on it here - the factory's
			// promise has not resolved yet, so `engine` is still unset.
			onRuntimeInitialized: function () {
				if (!SAFE_BUILD) return;
				try {
					this._RSDK_SetForceLog(1);
					this._RSDK_SetScriptTrace(1);
					RetroLog.info("early engine logging and script tracing enabled");
				} catch (err) {
					console.warn("[boot] could not enable early logging:", err);
					RetroLog.warn("could not enable early logging: " + err);
				}
			},

			onEngineStarted: () => {
				ui.boot.classList.add("hidden");
				document.title = titleForGame();
				ui.canvas.focus();

				if (!savesPersist) {
					console.warn("[boot] running without persistent storage - progress will be lost on reload");
				}
			},

			onEngineExit: () => {
				setStatus("The game closed.");
				ui.boot.classList.remove("hidden");
			},

			// A wasm trap arrives here as well as through window.onerror, and this
			// one carries the engine's own message rather than the runtime's.
			onAbort: what => {
				RetroLog.error("engine aborted: " + what);
				RetroLog.error("stack: " + new Error().stack);
				RetroLog.show(true);
			},
		};
	}

	function titleForGame() {
		try {
			switch (engine._RSDK_GetGameType()) {
				case 1: return "Sonic 1 Forever";
				case 2: return "Sonic 2 Absolute";
			}
		} catch { /* engine not up yet */ }
		return "RSDKv4 Web";
	}

	// The single-file build inlines the engine ahead of this script, so the
	// factory is already defined and there is nothing to fetch.
	const engineIsInlined = () => typeof createRetroEngine === "function";

	async function start() {
		ui.play.disabled = true;
		ui.error.classList.add("hidden");
		setStatus("Loading engine…");
		if (SAFE_BUILD) RetroLog.warn("using the heap-checked build — expect it to be very slow");
		RetroLog.info(`opcode list ${REV}`);
		setProgress(0.15);

		if (typeof WebAssembly !== "object" || typeof WebAssembly.instantiate !== "function") {
			ui.play.disabled = false;
			fail("This browser can't run WebAssembly, which the engine needs.\n" +
			     "If you're viewing this through an embed or preview pane, try opening it in a browser tab directly.");
			return;
		}

		try {
			if (!engineIsInlined()) await loadScript(bust(WASM_LOADER));
			setProgress(0.5);

			engine = await createRetroEngine(buildModuleConfig());
			setProgress(1);

			// The heap-checked build is only ever run to investigate something, and
			// the engine's own logging is what names the file it failed to load -
			// which is the usual reason a pointer is null in the first place. No
			// reason to make anyone ask for both separately.
			if (debugRequested || SAFE_BUILD) {
				engine.ccall("RSDK_SetDebugMode", null, ["number"], [1]);
				RetroLog.info("engine logging enabled");
			}

			wireEngine();
			watchForWrongOpcodeList();
		} catch (err) {
			ui.play.disabled = false;
			setProgress(null);
			fail("The engine failed to start.", err);
		}
	}

	// A data file compiled against a different opcode list loads every one of its
	// assets happily and only then reads its own bytecode as gibberish, so the
	// symptom is a black screen or a scene that reloads forever - nothing that
	// suggests a setting. The engine now counts both, so the page can try the
	// other lists itself instead of expecting someone to know about ?rev=.
	//
	// This matters most where the query string cannot help: an installed home
	// screen app launches its own start_url, and on iOS it gets a storage
	// container of its own, so it cannot inherit a choice made in the browser.
	function watchForWrongOpcodeList() {
		const order = ["2", "1nc", "0"];

		// Per-tab, so a genuine crash loop cannot bounce a device between builds
		// forever: each list is tried at most once per launch.
		let tried = [];
		try { tried = JSON.parse(sessionStorage.getItem("rsdkv4:triedLists") || "[]"); } catch (e) { /* private mode */ }
		if (!tried.includes(REV)) tried.push(REV);

		const next = order.find(r => !tried.includes(r));
		const getStatus = engine.cwrap("RSDK_GetStatusJSON", "string", []);

		// A blank screen has causes this cannot fix - missing stage assets, a
		// half-extracted file - and there is no point polling for those forever.
		const deadline = Date.now() + 30000;

		const timer = setInterval(() => {
			let s;
			try { s = JSON.parse(getStatus()); } catch (e) { return; }

			// Drawing something means the list is right; stop watching either way.
			if (!s.blank || Date.now() > deadline) { clearInterval(timer); return; }

			const looping = s.reloads >= 8;
			if (!s.scriptErrors && !looping) return;
			clearInterval(timer);

			const why = looping ? "the scene keeps reloading" : `the scripts stopped ${s.scriptErrors} time(s)`;
			if (!next) {
				RetroLog.warn(`${why}, and every opcode list has been tried. ` +
				              "This data file does not match any of them.");
				return;
			}

			RetroLog.warn(`${why} — opcode list ${REV} looks wrong for this file, trying ${next}`);
			try { sessionStorage.setItem("rsdkv4:triedLists", JSON.stringify(tried)); } catch (e) { /* private mode */ }
			try { localStorage.setItem(REV_KEY, next); } catch (e) { /* private mode */ }

			const url = new URL(location.href);
			url.searchParams.set("rev", next);
			url.searchParams.set("r", String(Date.now()));
			setTimeout(() => location.replace(url.toString()), 1200);
		}, 500);
	}

	function wireEngine() {
		// Handy from the browser console, and how the smoke tests confirm that a
		// touch really reaches the engine's input state.
		window.RetroEngineModule = engine;

		// From here the log reports what the engine itself says about its state,
		// and steps aside once there is actually a picture.
		RetroLog.watch(engine);

		const setButtonState = engine.cwrap("RSDK_SetButtonState", null, ["number", "number"]);
		const setFocused = engine.cwrap("RSDK_SetFocused", null, ["number"]);
		const clearButtons = engine.cwrap("RSDK_ClearButtonStates", null, []);
		const requestSaveSync = engine.cwrap("RSDK_RequestSaveSync", null, []);

		// Before the controls, so the reload it triggers happens while nothing is
		// being held.
		engine.ccall("RSDK_SetDeviceType", null, ["number"], [MOBILE ? 1 : 0]);
		RetroLog.info(`device type ${MOBILE ? "mobile — menus answer to taps on the picture" : "standard"}`);

		RetroControls.attach((button, held) => setButtonState(button, held ? 1 : 0));

		// Pause and drop every held button when the tab goes away, then flush the
		// save mount - a phone can kill a backgrounded tab without warning.
		document.addEventListener("visibilitychange", () => {
			const visible = !document.hidden;
			setFocused(visible ? 1 : 0);
			if (!visible) { clearButtons(); requestSaveSync(); }
		});

		window.addEventListener("pagehide", () => { clearButtons(); requestSaveSync(); });
		window.addEventListener("blur", () => clearButtons());
	}

	ui.play.addEventListener("click", start);

	RetroLog.attach();
	// The full URL, not just the path: a query parameter that failed to take
	// effect is indistinguishable from one that was never there otherwise.
	RetroLog.info(`page ${location.href}`);
	RetroLog.info(navigator.userAgent);
	RetroLog.info(`engine build: ${WASM_DIR}${BUILD ? " v=" + BUILD : " (unstamped)"}`);

	// ?debug=1 turns on the engine's own logging, which is off by default, so a
	// black screen can be investigated without rebuilding anything.
	if (params.get("debug") === "1") {
		debugRequested = true;
		RetroLog.info("debug mode requested");
	}

	/* -------------------------  service worker  ------------------------- */

	// Skipped for the single-file build: it is one document with no sw.js beside
	// it, and registering would only produce a 404 in the console.
	if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !engineIsInlined()) {
		window.addEventListener("load", () => {
			navigator.serviceWorker.register("sw.js").catch(err => {
				console.warn("[boot] service worker registration failed:", err);
			});
		});
	}

	/* -------------------------------  go  ------------------------------- */

	acquireData().catch(err => fail("Something went wrong while looking for the game data.", err));
})();
