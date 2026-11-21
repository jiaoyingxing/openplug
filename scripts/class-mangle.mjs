import fs from "node:fs";
import path from "node:path";

/**
 * 生产构建期 CSS 类名缩写。
 *
 * 源码与 `styles.css` 保留可读的 `op-*` 类名；构建时把两侧同时替换成
 * `op-` + 2 位短码。CSS 与 JS 必须共用同一张表，否则选择器失配——两边都
 * 从这里取映射。
 *
 * 类名来源：`styles.css` 选择器 ∪ TS 源码里以 `op-` 开头的类名串（`cls`
 * 值可能空格分隔多个类）。只改写完整 token（前后不是字母/数字/`_`/`-`），
 * 因此 `op-store` 不会误伤 `op-store-chip`。`op-blocks` 是 `addIcon` 的
 * 图标注册名、不是 CSS 类，保持原样；`is-*` 修饰类含宿主的 `is-phone` /
 * `is-mobile`，不参与。
 */
const KEEP = new Set(["op-blocks", "op-forum-spin"]);
const BOUNDARY = /[A-Za-z0-9_-]/;

/** 不参与缩写的 `op-` token（`op-blocks` 是图标注册名；`op-forum-spin` 是
 *  `@keyframes` 动画名，非 CSS 类）。构建断言用同一清单。 */
export const KEPT_TOKENS = [...KEEP];

function collectClassNames(srcDir, cssPath) {
	const names = new Set();
	const css = fs.readFileSync(cssPath, "utf8");
	for (const match of css.matchAll(/\.(op-[a-z0-9-]+)/g)) {
		names.add(match[1]);
	}
	for (const file of fs.readdirSync(srcDir)) {
		if (!file.endsWith(".ts")) {
			continue;
		}
		const text = fs.readFileSync(path.join(srcDir, file), "utf8");
		for (const match of text.matchAll(/"(?:op-[a-z0-9-]+(?: op-[a-z0-9-]+)*)"/g)) {
			for (const name of match[0].slice(1, -1).split(" ")) {
				if (name.startsWith("op-")) {
					names.add(name);
				}
			}
		}
	}
	for (const name of KEEP) {
		names.delete(name);
	}
	return names;
}

/** 稳定映射：按字典序分配短码，类名集合不变时产物可复现；短码撞原类名时跳过。 */
export function buildClassMap(srcDir = "src", cssPath = "styles.css") {
	const names = [...collectClassNames(srcDir, cssPath)].sort();
	const taken = new Set(names);
	const map = new Map();
	let code = 0;
	for (const name of names) {
		let alias;
		do {
			alias =
				"op-" +
				String.fromCharCode(97 + Math.floor(code / 26)) +
				String.fromCharCode(97 + (code % 26));
			code += 1;
		} while (taken.has(alias));
		taken.add(alias);
		map.set(name, alias);
	}
	return map;
}

/** 按最长优先替换，避免短名先吃掉长名前缀。 */
export function createClassRewriter(map) {
	const ordered = [...map.keys()].sort((a, b) => b.length - a.length);
	return (text) => {
		let result = text;
		for (const name of ordered) {
			const alias = map.get(name);
			let from = 0;
			while (true) {
				const index = result.indexOf(name, from);
				if (index < 0) {
					break;
				}
				const before = result[index - 1];
				const after = result[index + name.length];
				const standalone =
					(before === undefined || !BOUNDARY.test(before)) &&
					(after === undefined || !BOUNDARY.test(after));
				if (standalone) {
					result =
						result.slice(0, index) +
						alias +
						result.slice(index + name.length);
					from = index + alias.length;
				} else {
					from = index + name.length;
				}
			}
		}
		return result;
	};
}
