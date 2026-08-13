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

	const WASM_LOADER = "dist/s1fs2a.js";
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

	/* ---------------------------  small helpers  ------------------------ */

	const setStatus = text => { ui.status.textContent = text; };

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
			const bytes = await readPickedFile(file);
			setProgress(null);

			if (!looksLikeRSDK(bytes)) {
				fail("That doesn't look like an RSDKv4 data file. Look for Data.rsdk in your game's install folder.");
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

	document.getElementById("btn-forget").addEventListener("click", async () => {
		await RetroStorage.forgetDataFile();
		setStatus("Cached game data cleared. Reload to pick a different file.");
		document.getElementById("settings").classList.add("hidden");
	});

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
			locateFile: path => "dist/" + path,

			print: (...args) => console.log("[rsdk]", ...args),
			printErr: (...args) => console.warn("[rsdk]", ...args),

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
		setProgress(0.15);

		if (typeof WebAssembly !== "object" || typeof WebAssembly.instantiate !== "function") {
			ui.play.disabled = false;
			fail("This browser can't run WebAssembly, which the engine needs.\n" +
			     "If you're viewing this through an embed or preview pane, try opening it in a browser tab directly.");
			return;
		}

		try {
			if (!engineIsInlined()) await loadScript(WASM_LOADER);
			setProgress(0.5);

			engine = await createRetroEngine(buildModuleConfig());
			setProgress(1);

			wireEngine();
		} catch (err) {
			ui.play.disabled = false;
			setProgress(null);
			fail("The engine failed to start.", err);
		}
	}

	function wireEngine() {
		// Handy from the browser console, and how the smoke tests confirm that a
		// touch really reaches the engine's input state.
		window.RetroEngineModule = engine;

		const setButtonState = engine.cwrap("RSDK_SetButtonState", null, ["number", "number"]);
		const setFocused = engine.cwrap("RSDK_SetFocused", null, ["number"]);
		const clearButtons = engine.cwrap("RSDK_ClearButtonStates", null, []);
		const requestSaveSync = engine.cwrap("RSDK_RequestSaveSync", null, []);

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
