import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
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
		...builtinModules,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	legalComments: "none",
	// UTF-8 直出（默认 ascii 会把每个中文转义成 \uXXXX 的 6 字节；
	// Obsidian 按 UTF-8 读取插件 JS，中文每字 3 字节即可，实测省 ~9%）。
	charset: "utf8",
	outfile: "dist/release/main.js",
});

if (prod) {
	await context.rebuild();
	await context.dispose();
	// styles.css 走 esbuild 压缩（去注释/空白，语义不变）；仓库根保留可读源
	await esbuild.build({
		entryPoints: ["styles.css"],
		bundle: false,
		minify: true,
		outfile: "dist/release/styles.css",
		logLevel: "error",
	});
	const releaseDir = "dist/release";
	for (const f of ["manifest.json", "versions.json"]) {
		if (fs.existsSync(f)) {
			fs.copyFileSync(f, path.join(releaseDir, f));
			console.log(`copied ${f} -> ${releaseDir}`);
		}
	}
	process.exit(0);
} else {
	await context.watch();
}
