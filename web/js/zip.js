/* ==========================================================================
   Just enough ZIP to pull one file out of an archive.

   Game downloads almost always arrive zipped, and extracting one on a phone
   means leaving the browser, finding a file manager that can unzip, and coming
   back - which is exactly the sort of errand that makes people give up. Letting
   the picker accept the .zip directly removes the whole detour.

   Deliberately not a general ZIP library: it reads the central directory, finds
   one entry by name, and inflates it with the platform's own DecompressionStream.
   No dependency, and nothing to keep up to date.
   ========================================================================== */

const RetroZip = (() => {
	const EOCD_SIG = 0x06054b50;
	const CEN_SIG = 0x02014b50;
	const LOC_SIG = 0x04034b50;

	const METHOD_STORED = 0;
	const METHOD_DEFLATE = 8;

	/** A ZIP always ends with the End Of Central Directory record. */
	function findEOCD(view) {
		// The record is 22 bytes plus an optional comment of up to 64KB, so scan
		// backwards over the largest window it could be hiding in.
		const maxBack = Math.min(view.byteLength, 22 + 0xffff);
		for (let i = view.byteLength - 22; i >= view.byteLength - maxBack; i--) {
			if (i < 0) break;
			if (view.getUint32(i, true) === EOCD_SIG) return i;
		}
		return -1;
	}

	function decodeName(bytes, isUTF8) {
		// Bit 11 of the flags promises UTF-8; otherwise it is officially CP437,
		// but latin1 agrees with it for the ASCII names we care about.
		return new TextDecoder(isUTF8 ? "utf-8" : "latin1").decode(bytes);
	}

	/**
	 * List the entries in an archive.
	 * @param {Uint8Array} bytes
	 * @returns {Array<{name: string, method: number, compressedSize: number, size: number, offset: number}>}
	 */
	function listEntries(bytes) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

		const eocd = findEOCD(view);
		if (eocd < 0) throw new Error("not a ZIP archive");

		const count = view.getUint16(eocd + 10, true);
		let pos = view.getUint32(eocd + 16, true);

		if (pos === 0xffffffff) throw new Error("ZIP64 archives are not supported");

		const entries = [];
		for (let i = 0; i < count; i++) {
			if (pos + 46 > bytes.length || view.getUint32(pos, true) !== CEN_SIG) break;

			const flags = view.getUint16(pos + 8, true);
			const nameLen = view.getUint16(pos + 28, true);
			const extraLen = view.getUint16(pos + 30, true);
			const commentLen = view.getUint16(pos + 32, true);

			entries.push({
				name: decodeName(bytes.subarray(pos + 46, pos + 46 + nameLen), (flags & 0x800) !== 0),
				method: view.getUint16(pos + 10, true),
				compressedSize: view.getUint32(pos + 20, true),
				size: view.getUint32(pos + 24, true),
				offset: view.getUint32(pos + 42, true),
			});

			pos += 46 + nameLen + extraLen + commentLen;
		}

		return entries;
	}

	async function inflate(bytes) {
		if (typeof DecompressionStream !== "function") {
			throw new Error("this browser can't decompress ZIP archives");
		}
		// deflate-raw: ZIP stores the deflate payload without a zlib wrapper.
		const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	/** Where an entry's payload begins, per its own local header. */
	function payloadStart(bytes, entry) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

		if (view.getUint32(entry.offset, true) !== LOC_SIG) {
			throw new Error("damaged archive (bad local header)");
		}

		// The local header repeats the name and extra field, and its lengths are
		// the authoritative ones for locating the payload.
		const nameLen = view.getUint16(entry.offset + 26, true);
		const extraLen = view.getUint16(entry.offset + 28, true);
		return entry.offset + 30 + nameLen + extraLen;
	}

	/**
	 * Read just the first `n` bytes of an entry.
	 *
	 * Used to sniff an entry's type without paying to decompress it: an APK can
	 * hold a hundred entries and inflating each one in full to look at six bytes
	 * would take longer than the game does to load.
	 */
	async function peekEntry(bytes, entry, n) {
		const start = payloadStart(bytes, entry);
		const raw = bytes.subarray(start, start + entry.compressedSize);

		if (entry.method === METHOD_STORED) return raw.subarray(0, n);
		if (entry.method !== METHOD_DEFLATE) return new Uint8Array(0);
		if (typeof DecompressionStream !== "function") return new Uint8Array(0);

		const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
		const reader = stream.getReader();
		const out = new Uint8Array(n);
		let filled = 0;

		try {
			while (filled < n) {
				const { done, value } = await reader.read();
				if (done) break;
				const take = Math.min(n - filled, value.length);
				out.set(value.subarray(0, take), filled);
				filled += take;
			}
		} finally {
			// Abandon the rest of the stream rather than inflating it for nothing.
			reader.cancel().catch(() => {});
		}

		return out.subarray(0, filled);
	}

	/** Read one entry's bytes out of the archive. */
	async function readEntry(bytes, entry) {
		const start = payloadStart(bytes, entry);
		const raw = bytes.subarray(start, start + entry.compressedSize);

		if (entry.method === METHOD_STORED) return raw.slice();
		if (entry.method === METHOD_DEFLATE) return inflate(raw);

		throw new Error(`unsupported compression method ${entry.method}`);
	}

	/**
	 * Find a file inside an archive by its base name, ignoring case and any
	 * folders it is nested in.
	 *
	 * @param {Uint8Array} bytes archive contents
	 * @param {string} wanted e.g. "Data.rsdk"
	 * @returns {Promise<Uint8Array|null>}
	 */
	async function extractByName(bytes, wanted) {
		const target = wanted.toLowerCase();

		const matches = listEntries(bytes).filter(entry => {
			const base = entry.name.split("/").pop().toLowerCase();
			return base === target;
		});

		if (!matches.length) return null;

		// A archive holding several copies (one per game, say) is ambiguous;
		// the largest is the best guess at the real data file.
		matches.sort((a, b) => b.size - a.size);
		return readEntry(bytes, matches[0]);
	}

	// Entries smaller than this are not a game data pack, and skipping them keeps
	// the content sweep below off the hundreds of icons and layouts in an APK.
	const MIN_DATA_SIZE = 2 * 1024 * 1024;

	// Cap on how many entries the content sweep will decompress-and-sniff, so a
	// pathological archive cannot make the page sit there for a minute.
	const MAX_SNIFFED = 8;

	/**
	 * Find the game data inside an archive.
	 *
	 * APKs and OBBs are ZIPs, but unlike a tidy game download they bury the data
	 * under a path like `assets/`, and there is no guarantee it kept its original
	 * name. So this widens the search in stages, cheapest first:
	 *
	 *   1. an entry actually called Data.rsdk
	 *   2. any entry with a .rsdk extension
	 *   3. big entries, largest first, identified by what their bytes start with
	 *
	 * Stage 3 only reads each candidate's first few bytes, so a renamed file is
	 * still found without inflating a whole archive.
	 *
	 * @param {Uint8Array} bytes archive contents
	 * @param {(prefix: Uint8Array) => boolean} isDataFile tests an entry's first bytes
	 * @returns {Promise<{name: string, bytes: Uint8Array}|null>}
	 */
	async function findDataFile(bytes, isDataFile) {
		const entries = listEntries(bytes);
		const baseName = e => e.name.split("/").pop().toLowerCase();

		// Several copies (one per game, say) is ambiguous; the biggest is the
		// best guess at the real data pack.
		const biggestFirst = list => list.sort((a, b) => b.size - a.size);

		const byName = biggestFirst(entries.filter(e => baseName(e) === "data.rsdk"));
		if (byName.length) {
			return { name: byName[0].name, bytes: await readEntry(bytes, byName[0]) };
		}

		const byExtension = biggestFirst(entries.filter(e => baseName(e).endsWith(".rsdk")));
		if (byExtension.length) {
			return { name: byExtension[0].name, bytes: await readEntry(bytes, byExtension[0]) };
		}

		const candidates = biggestFirst(entries.filter(e => e.size >= MIN_DATA_SIZE)).slice(0, MAX_SNIFFED);
		for (const entry of candidates) {
			let prefix;
			try {
				prefix = await peekEntry(bytes, entry, 16);
			} catch {
				continue;                     // unreadable entry, try the next one
			}
			if (isDataFile(prefix)) {
				return { name: entry.name, bytes: await readEntry(bytes, entry) };
			}
		}

		return null;
	}

	/**
	 * Cheap check so we only try to parse things that really are archives.
	 * Covers .zip, and also .apk and .obb, which are ZIPs wearing a different
	 * extension.
	 */
	function looksLikeZip(bytes) {
		return bytes && bytes.length > 4 &&
			bytes[0] === 0x50 && bytes[1] === 0x4b &&          // "PK"
			(bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
	}

	return { looksLikeZip, listEntries, extractByName, findDataFile };
})();
