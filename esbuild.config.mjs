import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import fs from "fs";
import path from "path";

import {
	KEPT_TOKENS,
	buildClassMap,
	createClassRewriter,
} from "./scripts/class-mangle.mjs";

const banner = `/*
OpenPlug - install official Obsidian community plugins via domestic mirrors.
*/
`;

const prod = process.argv[2] === "production";
const RELEASE_DIR = "dist/release";
const JS_FILE = `${RELEASE_DIR}/main.js`;
const CSS_FILE = `${RELEASE_DIR}/styles.css`;

/** 产物里的 CSS 类名缩成 `op-` + 2 位短码（表见 `scripts/class-mangle.mjs`）。
 * 源码保留可读类名；CSS 与 JS 必须同一张表，否则选择器失配。 */
function mangleClasses(file) {
	const rewrite = createClassRewriter(buildClassMap());
	const before = fs.readFileSync(file, "utf8");
	const after = rewrite(before);
	if (after !== before) {
		fs.writeFileSync(file, after);
	}
}

/** 缩写后核对改写完整性：原名不得残留，出现的每个短码都必须在表内。 */
function assertMangling() {
	const map = buildClassMap();
	const aliases = new Set(map.values());
	for (const file of [JS_FILE, CSS_FILE]) {
		const text = fs.readFileSync(file, "utf8");
		for (const name of map.keys()) {
			if (new RegExp(`(?<![A-Za-z0-9_-])${name}(?![A-Za-z0-9_-])`).test(text)) {
				throw new Error(`类名未缩写：${name} 仍出现在 ${file}`);
			}
		}
		const tokens = new Set(
			[...text.matchAll(/(?<![A-Za-z0-9_-])(op-[a-z0-9-]+)(?![A-Za-z0-9_-])/g)].map(
				(m) => m[1],
			),
		);
		const unknown = [...tokens].filter(
			(token) => !aliases.has(token) && !KEPT_TOKENS.includes(token),
		);
		if (unknown.length) {
			throw new Error(
				`类名表外产物：${file} 出现 [${unknown.join(", ")}]（改类名后需重跑构建）`,
			);
		}
	}
}

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
	// Obsidian 1.11.4 起宿主运行时支持 ES2020；原生可选链/空值合并
	// 免去 es2018 转译辅助代码（实测 main.js 约 -2.9%）。
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	legalComments: "none",
	// 类内私有成员统一以 `_` 起名，构建时由 esbuild 改名压缩（实测 main.js
	// 约 -13%；dev 与生产构建同样生效）。只作用于本仓自有类的属性：以 `_`
	// 开头的键才会被改名，宿主的 `_app`/`_leaf` 等外部成员不受影响（该模式
	// 下 esbuild 不会改写引号属性的外部访问）。
	mangleProps: /^_/,
	// UTF-8 直出（默认 ascii 会把每个中文转义成 \uXXXX 的 6 字节；
	// Obsidian 按 UTF-8 读取插件 JS，中文每字 3 字节即可，实测省 ~9%）。
	charset: "utf8",
	outfile: JS_FILE,
	plugins: prod
		? [
				{
					name: "op-class-mangle",
					setup(build) {
						build.onEnd((result) => {
							if (!result.errors.length) {
								mangleClasses(JS_FILE);
							}
						});
					},
				},
			]
		: [],
});

if (prod) {
	await context.rebuild();
	await context.dispose();
	// styles.css 走 esbuild 压缩（去注释/空白，语义不变）；仓库根保留可读源
	await esbuild.build({
		entryPoints: ["styles.css"],
		bundle: false,
		minify: true,
		outfile: CSS_FILE,
		logLevel: "error",
	});
	mangleClasses(CSS_FILE);
	assertMangling();
	for (const f of ["manifest.json", "versions.json"]) {
		if (fs.existsSync(f)) {
			fs.copyFileSync(f, path.join(RELEASE_DIR, f));
			console.log(`copied ${f} -> ${RELEASE_DIR}`);
		}
	}
	// 商店构建检查要求的产物位置：仓库根或 dist/ 等常规位须出现 main.js，
	// 额外输出一份 dist/main.js（已 gitignore）；同步/发布仍以 dist/release 为准。
	fs.copyFileSync(JS_FILE, "dist/main.js");
	console.log("copied dist/release/main.js -> dist/main.js");
	process.exit(0);
} else {
	// 开发构建不改类名：JS 带 inline sourcemap，改写会打歪行列映射。dist 里的
	// CSS 也按未缩写重出一份，保证与 JS 的类名同一套（生产构建会覆盖）。
	await esbuild.build({
		entryPoints: ["styles.css"],
		bundle: false,
		minify: true,
		outfile: CSS_FILE,
		logLevel: "error",
	});
	await context.watch();
}
