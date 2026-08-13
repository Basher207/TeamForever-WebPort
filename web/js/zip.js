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

	/** Read one entry's bytes out of the archive. */
	async function readEntry(bytes, entry) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

		if (view.getUint32(entry.offset, true) !== LOC_SIG) {
			throw new Error("damaged archive (bad local header)");
		}

		// The local header repeats the name and extra field, and its lengths are
		// the authoritative ones for locating the payload.
		const nameLen = view.getUint16(entry.offset + 26, true);
		const extraLen = view.getUint16(entry.offset + 28, true);
		const start = entry.offset + 30 + nameLen + extraLen;
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

	/** Cheap check so we only try to parse things that really are archives. */
	function looksLikeZip(bytes) {
		return bytes && bytes.length > 4 &&
			bytes[0] === 0x50 && bytes[1] === 0x4b &&          // "PK"
			(bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
	}

	return { looksLikeZip, listEntries, extractByName };
})();
