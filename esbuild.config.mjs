import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";

const banner = `/*
OpenPlug - install official Obsidian community plugins via domestic mirrors.
*/
`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	legalComments: "none",
	outfile: "dist/release/main.js",
});

if (prod) {
	await context.rebuild();
	await context.dispose();
	const releaseDir = "dist/release";
	for (const f of ["manifest.json", "styles.css", "versions.json"]) {
		if (fs.existsSync(f)) {
			fs.copyFileSync(f, path.join(releaseDir, f));
			console.log(`copied ${f} -> ${releaseDir}`);
		}
	}
	process.exit(0);
} else {
	await context.watch();
}
