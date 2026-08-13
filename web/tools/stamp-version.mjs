/**
 * Stamp a build id onto every asset URL in index.html.
 *
 *   node web/tools/stamp-version.mjs <site-dir> <build-id>
 *
 * GitHub Pages serves everything with `Cache-Control: max-age=600` and no
 * version in the URL, so a browser can hold a ten-minute-stale boot.js while
 * fetching a fresh index.html. The two then disagree, and the result is a page
 * that half works in ways that look like real bugs. A build id in the query
 * string makes that impossible: new HTML can only ever reference new assets.
 *
 * Run against the assembled site directory, not the source tree.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const [siteDir, buildId] = process.argv.slice(2);

if (!siteDir || !buildId) {
	console.error("usage: node web/tools/stamp-version.mjs <site-dir> <build-id>");
	process.exit(2);
}

const version = buildId.slice(0, 12).replace(/[^\w.-]/g, "");

const indexPath = resolve(siteDir, "index.html");
if (!existsSync(indexPath)) {
	console.error(`error: ${indexPath} not found`);
	process.exit(1);
}

let html = readFileSync(indexPath, "utf8");
let stamped = 0;

// Local scripts and stylesheets only; anything absolute belongs to someone else.
html = html.replace(/\b(src|href)="((?:js\/[\w.-]+\.js|styles\.css))"/g, (_, attr, url) => {
	stamped++;
	return `${attr}="${url}?v=${version}"`;
});

// The wasm loader is fetched from JS rather than markup, so hand the id over
// in a global for boot.js to append.
html = html.replace(/<script src="js\//, `<script>window.__BUILD__ = ${JSON.stringify(version)};</script>\n<script src="js/`);

writeFileSync(indexPath, html);

// Keep the service worker's cache keyed to the build too, so an old shell is
// never resurrected from it.
const swPath = resolve(siteDir, "sw.js");
if (existsSync(swPath)) {
	const sw = readFileSync(swPath, "utf8").replace(
		/const CACHE = "[^"]*";/,
		`const CACHE = "rsdkv4-web-shell-${version}";`
	);
	writeFileSync(swPath, sw);
}

console.log(`stamped ${stamped} asset URLs with v=${version}`);
