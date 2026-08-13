/* ==========================================================================
   On-screen log.

   A phone has no console, so when the screen stays black there is nothing to
   look at and nothing to report. This puts the same information on the screen:
   the boot steps, whatever the engine writes to stdout/stderr, and a periodic
   snapshot of the engine's own state.

   It gets out of the way by itself once the game is visibly drawing, and comes
   back on demand. "Visibly drawing" is asked of the engine rather than guessed
   at from a timer, so a screen that stays black keeps its log.
   ========================================================================== */

const RetroLog = (() => {
	const MAX_LINES = 300;

	// The game has to be drawing something other than a flat colour for this
	// many consecutive polls before the log steps aside - one good frame could
	// just be a fade passing through.
	const CLEAR_POLLS = 3;

	// How often to ask the engine how it is doing, in ms. Frequent enough to
	// feel live, rare enough to cost nothing.
	const POLL_MS = 500;

	let panel, body, badge;
	let engine = null;
	let pollTimer = null;
	let goodPolls = 0;
	let autoHidden = false;
	let userPinned = false;         // an explicit tap beats the auto-hide
	let lastStatus = "";
	const lines = [];

	function stamp() {
		return (performance.now() / 1000).toFixed(2).padStart(6, " ");
	}

	function add(text, kind) {
		const line = `${stamp()}  ${text}`;
		lines.push(line);
		if (lines.length > MAX_LINES) lines.shift();

		if (!body) return;

		const el = document.createElement("div");
		el.className = "log-line" + (kind ? " log-" + kind : "");
		el.textContent = line;
		body.appendChild(el);
		while (body.childElementCount > MAX_LINES) body.removeChild(body.firstChild);

		// Only chase the bottom if the reader is already there, so scrolling back
		// through a long boot isn't yanked away.
		const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
		if (nearBottom) body.scrollTop = body.scrollHeight;
	}

	const info = text => add(text, null);
	const warn = text => add(text, "warn");
	const error = text => add(text, "error");

	/**
	 * Log a stack trace, trimmed. Frames beyond the top dozen are almost always
	 * the runtime's own plumbing, and a wall of them buries the useful lines.
	 */
	function reportStack(stack) {
		const frames = String(stack).split("\n").map(s => s.trim()).filter(Boolean).slice(0, 12);
		for (const frame of frames) add("  at " + frame, "error");
	}

	function show(pinned) {
		if (pinned) userPinned = true;
		panel.classList.remove("hidden");
		badge.classList.add("hidden");
	}

	function hide(auto) {
		if (auto && userPinned) return;
		panel.classList.add("hidden");
		badge.classList.remove("hidden");
	}

	/* ------------------------  engine state polling  -------------------- */

	function poll() {
		if (!engine) return;

		let status;
		try {
			status = engine.UTF8ToString(engine._RSDK_GetStatusJSON());
		} catch (err) {
			return;                        // engine gone; nothing to report
		}

		// Memory is worth watching: wasm grows its heap on demand, and a growth
		// a phone refuses turns into a failed allocation and then a wild pointer.
		// Seeing the size right before a trap says whether that is what happened.
		let heap = "";
		try {
			if (engine.HEAPU8) heap = ` heap=${(engine.HEAPU8.length / (1024 * 1024)).toFixed(0)}MB`;
		} catch { /* not exported in this build */ }

		// Only log when something actually changed, otherwise the panel fills
		// with identical lines and the interesting one scrolls away.
		if (status !== lastStatus) {
			lastStatus = status;
			info("engine " + status + heap);
		}

		let parsed;
		try {
			parsed = JSON.parse(status);
		} catch {
			return;
		}

		if (!parsed.running) {
			warn("engine has stopped running");
			return;
		}

		if (parsed.frames > 0 && !parsed.blank) {
			if (++goodPolls >= CLEAR_POLLS && !autoHidden) {
				autoHidden = true;
				info("picture is up — hiding this log (tap the ⌄ to bring it back)");
				hide(true);
			}
		} else {
			goodPolls = 0;
		}
	}

	/* -----------------------------  wiring  ----------------------------- */

	function attach() {
		panel = document.getElementById("log");
		body = document.getElementById("log-body");
		badge = document.getElementById("log-badge");

		// Replay anything logged before the DOM was wired up.
		for (const line of lines) {
			const el = document.createElement("div");
			el.className = "log-line";
			el.textContent = line;
			body.appendChild(el);
		}

		document.getElementById("log-hide").addEventListener("click", () => {
			userPinned = false;
			hide(false);
		});
		badge.addEventListener("click", () => show(true));

		document.getElementById("log-copy").addEventListener("click", async ev => {
			const button = ev.currentTarget;
			const text = lines.join("\n");
			try {
				await navigator.clipboard.writeText(text);
				button.textContent = "Copied";
			} catch {
				// Clipboard is blocked without a secure context or permission;
				// selecting the text is the next best thing.
				const range = document.createRange();
				range.selectNodeContents(body);
				const sel = getSelection();
				sel.removeAllRanges();
				sel.addRange(range);
				button.textContent = "Select + copy";
			}
			setTimeout(() => { button.textContent = "Copy"; }, 2000);
		});

		// Surface anything that would otherwise only reach the console. The stack
		// is the valuable half: a wasm trap's message says nothing about where it
		// happened, and the build keeps function names so the frames are readable.
		window.addEventListener("error", ev => {
			error("js error: " + ev.message);
			if (ev.error && ev.error.stack) reportStack(ev.error.stack);
		});
		window.addEventListener("unhandledrejection", ev => {
			error("unhandled rejection: " + ev.reason);
			if (ev.reason && ev.reason.stack) reportStack(ev.reason.stack);
		});
	}

	/** Start watching the engine once it exists. */
	function watch(module) {
		engine = module;
		goodPolls = 0;
		autoHidden = false;
		clearInterval(pollTimer);
		pollTimer = setInterval(poll, POLL_MS);
		poll();
	}

	return { attach, watch, info, warn, error, show, hide };
})();
