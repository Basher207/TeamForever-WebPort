/* ==========================================================================
   Persistent storage for the web build.

   Two different things need to survive a reload, and they want very different
   treatment:

   * The data file (Data.rsdk) is tens of megabytes and never changes. It goes
     into IndexedDB as one blob under our own key, and into the wasm filesystem
     as a plain in-memory file. Round-tripping it through emscripten's IDBFS
     would mean re-serialising it on every save.

   * Save games and settings are a few kilobytes and change constantly. Those
     live on an IDBFS mount that the engine writes to directly; the engine asks
     for a flush when it has written something.
   ========================================================================== */

const RetroStorage = (() => {
	const DB_NAME = "rsdkv4-web";
	const DB_VERSION = 1;
	const STORE = "files";
	const DATA_KEY = "Data.rsdk";

	let dbPromise = null;

	function openDB() {
		if (dbPromise) return dbPromise;

		dbPromise = new Promise((resolve, reject) => {
			let req;
			try {
				req = indexedDB.open(DB_NAME, DB_VERSION);
			} catch (err) {
				reject(err);
				return;
			}

			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
			req.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
		});

		return dbPromise;
	}

	function tx(mode, fn) {
		return openDB().then(db => new Promise((resolve, reject) => {
			const t = db.transaction(STORE, mode);
			const store = t.objectStore(STORE);
			let result;
			try {
				result = fn(store);
			} catch (err) {
				reject(err);
				return;
			}
			t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
			t.onerror = () => reject(t.error);
			t.onabort = () => reject(t.error || new Error("transaction aborted"));
		}));
	}

	/** Cached game data file, or null if we've never been given one. */
	async function loadDataFile() {
		try {
			const value = await tx("readonly", store => store.get(DATA_KEY));
			if (!value) return null;
			// Stored as an ArrayBuffer; older Safari hands back a Blob.
			if (value instanceof ArrayBuffer) return new Uint8Array(value);
			if (value instanceof Uint8Array) return value;
			if (typeof Blob !== "undefined" && value instanceof Blob) {
				return new Uint8Array(await value.arrayBuffer());
			}
			return null;
		} catch (err) {
			console.warn("[storage] could not read the cached data file:", err);
			return null;
		}
	}

	async function saveDataFile(bytes) {
		try {
			// Copy into a standalone buffer: a view over the wasm heap would be
			// meaningless once memory grows.
			const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			await tx("readwrite", store => store.put(buffer, DATA_KEY));
			return true;
		} catch (err) {
			// Quota errors are common on iOS; the game still runs this session.
			console.warn("[storage] could not cache the data file:", err);
			return false;
		}
	}

	async function forgetDataFile() {
		try {
			await tx("readwrite", store => store.delete(DATA_KEY));
			return true;
		} catch (err) {
			console.warn("[storage] could not clear the cached data file:", err);
			return false;
		}
	}

	/**
	 * Ask the browser to keep our data around under storage pressure. Best
	 * effort - a decline is not a problem, it just means eviction is possible.
	 */
	async function requestPersistence() {
		try {
			if (navigator.storage && navigator.storage.persist) {
				if (await navigator.storage.persisted()) return true;
				return await navigator.storage.persist();
			}
		} catch { /* not supported */ }
		return false;
	}

	return { loadDataFile, saveDataFile, forgetDataFile, requestPersistence, DATA_KEY };
})();
