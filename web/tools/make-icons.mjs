/**
 * Regenerate the PNG launcher icons from icons/icon.svg.
 *
 * Only needed when the artwork changes - the PNGs are committed.
 *
 *   npm i -g playwright   (or have it available some other way)
 *   node web/tools/make-icons.mjs
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(here, "..", "icons");
const svg = readFileSync(resolve(iconsDir, "icon.svg"), "utf8");

// Android crops maskable icons to a circle inscribed in the middle 80%, so the
// artwork is shrunk into that safe zone and the background bled out to the edge.
const maskable = svg.replace(
	/(<rect width="512" height="512" fill="url\(#bg\)"\/>)/,
	'$1<g transform="translate(256 256) scale(0.72) translate(-256 -256)">'
).replace("</svg>", "</g></svg>");

const targets = [
	{ file: "icon-192.png", size: 192, source: svg },
	{ file: "icon-512.png", size: 512, source: svg },
	{ file: "icon-maskable-512.png", size: 512, source: maskable },
];

const browser = await chromium.launch();

for (const { file, size, source } of targets) {
	const page = await browser.newPage({
		viewport: { width: size, height: size },
		deviceScaleFactor: 1,
	});

	await page.setContent(
		`<style>html,body{margin:0;padding:0;background:transparent}
		 svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
		{ waitUntil: "load" }
	);

	writeFileSync(resolve(iconsDir, file), await page.screenshot({ omitBackground: true }));
	console.log("wrote", file, `(${size}x${size})`);
	await page.close();
}

await browser.close();
