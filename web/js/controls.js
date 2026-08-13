/* ==========================================================================
   On-screen controls.

   Everything is driven off pointer events collected at the window level rather
   than per-button listeners, because a game pad has to behave like a physical
   one: a thumb that slides off "left" and onto "down" should change direction
   without lifting, two thumbs must work at once, and a finger leaving the
   element must not leave a button stuck down.

   So: every active pointer that started on a pad is tracked, the full button
   state is recomputed from scratch on each event, and only the differences are
   pushed into the engine.
   ========================================================================== */

const RetroControls = (() => {
	// Mirrors enum InputButtons in RSDKv4/Input.hpp
	const BUTTON = {
		UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3,
		A: 4, B: 5, C: 6,
		X: 7, Y: 8, Z: 9,
		L: 10, R: 11,
		START: 12, SELECT: 13,
	};

	const SETTINGS_KEY = "rsdkv4-web:controls";

	// Fraction of the d-pad radius a thumb must travel before it counts as a
	// direction. Small enough to feel responsive, big enough that resting a
	// thumb in the middle doesn't twitch left and right.
	const DPAD_DEADZONE = 0.22;

	let setButtonFn = null;

	const state = {};          // buttonId -> bool, what the engine currently has
	const pointers = new Map(); // pointerId -> { pad: 'dpad'|'face', x, y }

	let els = {};
	let settings = {
		enabled: true,
		scale: 100,
		opacity: 70,
		haptics: true,
	};

	/* ----------------------------  helpers  ----------------------------- */

	function loadSettings() {
		try {
			const raw = localStorage.getItem(SETTINGS_KEY);
			if (raw) Object.assign(settings, JSON.parse(raw));
		} catch { /* private mode, defaults are fine */ }
	}

	function saveSettings() {
		try {
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
		} catch { /* ignore */ }
	}

	function applySettings() {
		const root = document.documentElement;
		root.style.setProperty("--pad-scale", (settings.scale / 100).toFixed(3));
		root.style.setProperty("--pad-opacity", (settings.opacity / 100).toFixed(3));

		els.controls.classList.toggle("hidden", !settings.enabled);
		if (!settings.enabled) releaseAll();
	}

	function buzz() {
		if (!settings.haptics) return;
		if (navigator.vibrate) {
			try { navigator.vibrate(8); } catch { /* blocked */ }
		}
	}

	/* --------------------------  engine bridge  ------------------------- */

	function push(button, held) {
		if (state[button] === held) return;
		state[button] = held;
		if (setButtonFn) setButtonFn(button, held);
		if (held) buzz();
	}

	function releaseAll() {
		pointers.clear();
		for (const id of Object.values(BUTTON)) push(id, false);
		paintDpad(null);
		paintFace(new Set());
	}

	/* -----------------------------  d-pad  ------------------------------ */

	// Returns the set of directions for a point inside the d-pad, using 8-way
	// segmentation so diagonals (needed for spindash and slopes) come naturally.
	function dpadDirections(rect, x, y) {
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const radius = Math.min(rect.width, rect.height) / 2;

		const dx = (x - cx) / radius;
		const dy = (y - cy) / radius;
		const dist = Math.hypot(dx, dy);

		const dirs = new Set();
		if (dist < DPAD_DEADZONE) return { dirs, dx: 0, dy: 0 };

		// Angle measured clockwise from "right", split into 8 sectors of 45deg.
		let angle = Math.atan2(dy, dx) * 180 / Math.PI;
		if (angle < 0) angle += 360;
		const sector = Math.round(angle / 45) % 8;

		//  0 right, 1 down-right, 2 down, 3 down-left, 4 left, 5 up-left, 6 up, 7 up-right
		if (sector === 7 || sector === 0 || sector === 1) dirs.add(BUTTON.RIGHT);
		if (sector === 1 || sector === 2 || sector === 3) dirs.add(BUTTON.DOWN);
		if (sector === 3 || sector === 4 || sector === 5) dirs.add(BUTTON.LEFT);
		if (sector === 5 || sector === 6 || sector === 7) dirs.add(BUTTON.UP);

		// Clamp the knob to the plate so it reads as a real stick.
		const clamp = Math.min(dist, 1);
		return { dirs, dx: (dx / dist) * clamp, dy: (dy / dist) * clamp };
	}

	function paintDpad(info) {
		const pad = els.dpad;
		pad.classList.toggle("active", !!info && info.dirs.size > 0);
		pad.classList.toggle("up", !!info && info.dirs.has(BUTTON.UP));
		pad.classList.toggle("down", !!info && info.dirs.has(BUTTON.DOWN));
		pad.classList.toggle("left", !!info && info.dirs.has(BUTTON.LEFT));
		pad.classList.toggle("right", !!info && info.dirs.has(BUTTON.RIGHT));

		const nub = els.nub;
		if (info && (info.dx || info.dy)) {
			nub.style.transform = `translate(${(info.dx * 34).toFixed(1)}%, ${(info.dy * 34).toFixed(1)}%)`;
		} else {
			nub.style.transform = "";
		}
	}

	/* --------------------------  face buttons  -------------------------- */

	// Round buttons, so hit-test by distance to centre rather than by rect;
	// a little slop makes the edges forgiving on a moving thumb.
	function faceButtonAt(x, y) {
		let best = null;
		let bestDist = Infinity;

		for (const btn of els.faceButtons) {
			const rect = btn.getBoundingClientRect();
			if (!rect.width) continue;

			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const r = rect.width / 2 + 6;
			const dist = Math.hypot(x - cx, y - cy);

			if (dist <= r && dist < bestDist) {
				best = btn;
				bestDist = dist;
			}
		}
		return best;
	}

	function paintFace(heldButtons) {
		for (const btn of els.faceButtons) {
			btn.classList.toggle("held", heldButtons.has(btn));
		}
	}

	/* ---------------------------  event loop  --------------------------- */

	function recompute() {
		const dirs = new Set();
		const heldEls = new Set();
		const heldIds = new Set();
		let dpadInfo = null;

		for (const p of pointers.values()) {
			if (p.pad === "dpad") {
				const info = dpadDirections(els.dpad.getBoundingClientRect(), p.x, p.y);
				for (const d of info.dirs) dirs.add(d);
				dpadInfo = info;
			} else {
				const btn = faceButtonAt(p.x, p.y);
				if (btn) {
					heldEls.add(btn);
					heldIds.add(BUTTON[btn.dataset.button]);
				}
			}
		}

		push(BUTTON.UP, dirs.has(BUTTON.UP));
		push(BUTTON.DOWN, dirs.has(BUTTON.DOWN));
		push(BUTTON.LEFT, dirs.has(BUTTON.LEFT));
		push(BUTTON.RIGHT, dirs.has(BUTTON.RIGHT));

		for (const name of ["A", "B", "C", "START", "SELECT"]) {
			push(BUTTON[name], heldIds.has(BUTTON[name]));
		}

		paintDpad(dpadInfo);
		paintFace(heldEls);
	}

	function padFor(target) {
		if (!(target instanceof Element)) return null;
		if (target.closest("#dpad")) return "dpad";
		if (target.closest("#face") || target.closest(".pad-system")) return "face";
		return null;
	}

	function onPointerDown(ev) {
		if (!settings.enabled) return;

		const pad = padFor(ev.target);
		if (!pad) return;

		ev.preventDefault();
		pointers.set(ev.pointerId, { pad, x: ev.clientX, y: ev.clientY });
		recompute();
	}

	function onPointerMove(ev) {
		const p = pointers.get(ev.pointerId);
		if (!p) return;

		ev.preventDefault();
		p.x = ev.clientX;
		p.y = ev.clientY;
		recompute();
	}

	function onPointerUp(ev) {
		if (!pointers.has(ev.pointerId)) return;

		pointers.delete(ev.pointerId);
		recompute();
	}

	/* -----------------------------  wiring  ----------------------------- */

	function bindSettingsSheet() {
		const sheet = document.getElementById("settings");
		const openBtn = document.getElementById("btn-settings");
		const closeBtn = document.getElementById("btn-settings-close");

		const enabled = document.getElementById("opt-enabled");
		const scale = document.getElementById("opt-scale");
		const opacity = document.getElementById("opt-opacity");
		const haptics = document.getElementById("opt-haptics");
		const outScale = document.getElementById("out-scale");
		const outOpacity = document.getElementById("out-opacity");

		enabled.checked = settings.enabled;
		scale.value = settings.scale;
		opacity.value = settings.opacity;
		haptics.checked = settings.haptics;
		outScale.textContent = settings.scale + "%";
		outOpacity.textContent = settings.opacity + "%";

		const open = () => sheet.classList.remove("hidden");
		const close = () => sheet.classList.add("hidden");

		openBtn.addEventListener("click", open);
		closeBtn.addEventListener("click", close);
		sheet.addEventListener("click", ev => { if (ev.target === sheet) close(); });

		enabled.addEventListener("change", () => {
			settings.enabled = enabled.checked;
			applySettings(); saveSettings();
		});
		scale.addEventListener("input", () => {
			settings.scale = +scale.value;
			outScale.textContent = settings.scale + "%";
			applySettings(); saveSettings();
		});
		opacity.addEventListener("input", () => {
			settings.opacity = +opacity.value;
			outOpacity.textContent = settings.opacity + "%";
			applySettings(); saveSettings();
		});
		haptics.addEventListener("change", () => {
			settings.haptics = haptics.checked;
			saveSettings();
		});
	}

	function bindFullscreen() {
		const btn = document.getElementById("btn-fullscreen");
		const root = document.getElementById("app");

		btn.addEventListener("click", async () => {
			try {
				if (document.fullscreenElement) {
					await document.exitFullscreen();
					return;
				}

				if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: "hide" });
				else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();

				// Landscape suits a 16:9 game; phones that refuse just stay put.
				if (screen.orientation && screen.orientation.lock) {
					try { await screen.orientation.lock("landscape"); } catch { /* not allowed */ }
				}
			} catch (err) {
				console.warn("[controls] fullscreen request failed:", err);
			}
		});
	}

	/**
	 * @param {(button:number, held:boolean) => void} setButton
	 *        pushes a single button state into the engine
	 */
	function attach(setButton) {
		setButtonFn = setButton;

		els = {
			controls: document.getElementById("controls"),
			dpad: document.getElementById("dpad"),
			nub: document.getElementById("dpad-nub"),
			face: document.getElementById("face"),
			faceButtons: Array.from(document.querySelectorAll("[data-button]")),
		};

		loadSettings();
		applySettings();
		bindSettingsSheet();
		bindFullscreen();

		els.controls.removeAttribute("aria-hidden");

		// passive:false so preventDefault can stop the browser turning a swipe on
		// the d-pad into a page gesture.
		const opts = { passive: false };
		window.addEventListener("pointerdown", onPointerDown, opts);
		window.addEventListener("pointermove", onPointerMove, opts);
		window.addEventListener("pointerup", onPointerUp, opts);
		window.addEventListener("pointercancel", onPointerUp, opts);

		// Any interruption releases everything; a stuck direction is worse than a
		// dropped input.
		window.addEventListener("blur", releaseAll);
		document.addEventListener("visibilitychange", () => {
			if (document.hidden) releaseAll();
		});

		// The pads are absolutely positioned; a rotation moves them all.
		window.addEventListener("resize", releaseAll);
		window.addEventListener("orientationchange", releaseAll);

		// Belt and braces against long-press menus and pinch zoom on the deck.
		document.addEventListener("contextmenu", ev => {
			if (padFor(ev.target)) ev.preventDefault();
		});
		document.addEventListener("gesturestart", ev => ev.preventDefault());
	}

	return { attach, releaseAll, BUTTON, get settings() { return settings; } };
})();
