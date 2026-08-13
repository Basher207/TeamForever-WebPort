/**
 * Bundle the web build into one self-contained HTML file.
 *
 *   ./web/build.sh                                       # normal build first
 *   emmake make PLATFORM=Emscripten SINGLE_FILE=1 OUTDIR=web/dist-single
 *   node web/tools/bundle-standalone.mjs [out.html]
 *
 * The result has no external references at all - CSS, scripts and the wasm (as
 * base64, courtesy of -sSINGLE_FILE=1) are all inline. That makes it hostable
 * anywhere that will serve a single document, including sandboxed viewers that
 * forbid subresource requests.
 *
 * It still contains no game assets: the page asks the player for their own data
 * file exactly as the multi-file build does.
 *
 * Pass --fragment to emit just <title>/<style>/markup/<script> with no
 * <html>/<head>/<body> wrapper, for hosts that supply their own document shell.
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");

const args = process.argv.slice(2).filter(a => a !== "--fragment");
const fragment = process.argv.includes("--fragment");
const outPath = args[0] || resolve(web, "dist-single", "rsdkv4-standalone.html");

const read = p => readFileSync(resolve(web, p), "utf8");

const enginePath = resolve(web, "dist-single", "s1fs2a.js");
try {
	statSync(enginePath);
} catch {
	console.error(`error: ${enginePath} is missing.\n` +
		"Build it first:\n" +
		"  emmake make PLATFORM=Emscripten SINGLE_FILE=1 OUTDIR=web/dist-single");
	process.exit(1);
}

const html = read("index.html");

// Take the page body out of index.html so the two builds can never drift apart.
const appMatch = html.match(/<div id="app">[\s\S]*<\/div>\s*(?=<script)/);
if (!appMatch) {
	console.error("error: could not find the #app block in index.html");
	process.exit(1);
}

// </script> inside a script element would close it early; nothing here should
// contain one, but a stray occurrence would be a silent, baffling breakage.
const guard = (label, source) => {
	if (source.includes("</script")) {
		console.error(`error: ${label} contains a literal </script`);
		process.exit(1);
	}
	return source;
};

const TITLE = "<title>Sonic Forever Web</title>";
const STYLE = "<style>\n" + read("styles.css") + "\n</style>";

const bodyParts = [
	appMatch[0].trim(),
	"<script>\n" + guard("storage.js", read("js/storage.js")) + "\n</script>",
	"<script>\n" + guard("controls.js", read("js/controls.js")) + "\n</script>",
	"<script>\n" + guard("engine", readFileSync(enginePath, "utf8")) + "\n</script>",
	"<script>\n" + guard("boot.js", read("js/boot.js")) + "\n</script>",
].join("\n\n");

// Fragment form: the host wraps this in its own document, so emit the pieces
// bare and let it place them. Standalone form: a complete, valid document.
const page = fragment
	? [TITLE, STYLE, bodyParts].join("\n\n")
	: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0b1020">
${TITLE}
${STYLE}
</head>
<body>
${bodyParts}
</body>
</html>`;

writeFileSync(outPath, page);

const mb = (statSync(outPath).size / (1024 * 1024)).toFixed(2);
console.log(`wrote ${outPath} (${mb} MB${fragment ? ", fragment" : ""})`);
