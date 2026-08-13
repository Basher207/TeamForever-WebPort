/* ==========================================================================
   Service worker: makes the shell installable and playable offline.

   Deliberately network-first for everything. The alternative - cache-first with
   a version stamp - means a rebuilt wasm can sit behind a stale cache until the
   version is remembered to be bumped, and a stale engine paired with fresh JS
   fails in confusing ways. The whole shell is under two megabytes, so revalidating
   it costs little, and the real bulk (the game data file) never travels through
   here at all: it lives in IndexedDB.
   ========================================================================== */

const CACHE = "rsdkv4-web-shell";

const PRECACHE = [
	"./",
	"./index.html",
	"./styles.css",
	"./js/storage.js",
	"./js/controls.js",
	"./js/boot.js",
	"./manifest.webmanifest",
	"./icons/icon.svg",
];

self.addEventListener("install", event => {
	event.waitUntil(
		caches.open(CACHE)
			// Individually, so one missing optional file can't fail the install.
			.then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url))))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener("activate", event => {
	event.waitUntil(
		caches.keys()
			.then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener("fetch", event => {
	const request = event.request;

	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	// The data file can be hundreds of megabytes and is cached in IndexedDB by
	// the page itself; keeping a second copy here would double the storage cost.
	if (url.pathname.endsWith(".rsdk")) return;

	event.respondWith(
		fetch(request)
			.then(response => {
				if (response && response.ok && response.type === "basic") {
					const copy = response.clone();
					caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
				}
				return response;
			})
			.catch(() => caches.match(request).then(hit => hit || caches.match("./index.html")))
	);
});
