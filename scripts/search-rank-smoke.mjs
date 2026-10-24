#!/usr/bin/env node
/**
 * OpenPlug 搜索结果排序行为钉（2026-10-25，用户要求「轻量、自然、简单」）。
 *
 * 钉面：
 * 1. 命中档位顺序：名称全等 > 名称前缀 > 名称包含 > 作者 > ID/仓库 > 仅简介；
 * 2. 未命中返回 -1，不进入结果集；
 * 3. 同档按名称长度、再按名称本地化序；与清单原始顺序无关，同输入同输出。
 *
 * 纯模块 src/search-rank.ts 不引 obsidian；用 esbuild 打成临时 ESM 后导入。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "openplug-search-rank-"));
const outfile = path.join(tempDir, "search-rank.mjs");

let passed = 0;
let failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`  FAIL ${name}`);
		console.error(error?.stack ?? String(error));
	}
}

try {
	await build({
		entryPoints: [path.join(root, "src", "search-rank.ts")],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2020",
		outfile,
		logLevel: "silent",
	});
	const { searchHitRank, compareSearchHit, sortSearchHits } = await import(
		`${pathToFileURL(outfile).href}?t=${Date.now()}`
	);

	/** 与 view.ts 的调用一致：字段先转小写，再算档位。 */
	function rankOf(entry, q) {
		return searchHitRank(
			entry.name.toLowerCase(),
			entry.author.toLowerCase(),
			entry.id.toLowerCase(),
			entry.desc.toLowerCase(),
			q.toLowerCase(),
		);
	}

	await test("hit tiers: exact > prefix > contains > author > id > desc", () => {
		const base = { name: "Importer", author: "Obsidian", id: "obsidian-importer", desc: "Convert your data" };
		assert.equal(rankOf(base, "importer"), 0, "名称全等");
		assert.equal(rankOf({ ...base, name: "Importer Pro" }, "importer"), 1, "名称前缀");
		assert.equal(rankOf({ ...base, name: "Style Importer" }, "importer"), 2, "名称包含");
		assert.equal(rankOf({ ...base, name: "SomethingElse" }, "obsidian"), 3, "作者命中");
		assert.equal(rankOf({ ...base, name: "SomethingElse", author: "x" }, "importer"), 4, "ID 命中");
		assert.equal(
			rankOf({ ...base, name: "Other", author: "x", id: "y" }, "convert"),
			5,
			"仅简介命中",
		);
		assert.equal(rankOf(base, "dataview"), -1, "未命中");
	});

	await test("same tier: shorter name first, then localized name order", () => {
		// 用户附图那批 importer（清单原始顺序与预期排序不同，验证不继承清单顺序）。
		const entries = [
			{ name: "JSON-CSV Importer", id: "json-csv-importer", author: "faring42", desc: "Import a JSON file containing an array of data" },
			{ name: "Kobo Highlights Importer", id: "kobo-highlights-importer", author: "ogkevin", desc: "Import highlights from Kobo devices." },
			{ name: "Flomo Importer", id: "flomo-importer", author: "jia6y", desc: "Make Flomo memos to notes." },
			{ name: "Tolino notes Importer", id: "tolino-notes-importer", author: "juergenbr", desc: "Import notes from a Tolino E-Reader." },
			{ name: "Pocketbook Cloud Highlight Importer", id: "pocketbook-cloud-highlight-importer", author: "lenalebt", desc: "Import notes and highlights from your Pocketbook Cloud account." },
			{ name: "Importer", id: "obsidian-importer", author: "Obsidian", desc: "Convert your data to Markdown files" },
			{ name: "Style Importer", id: "style-importer", author: "joshrouwhorst", desc: "Import a stylesheet from a URL into your snippets folder." },
			{ name: "Wikidata Importer", id: "wikidata-importer", author: "samwho", desc: "Import Wikidata entries." },
		];
		const sorted = entries
			.map((e) => ({ ...e, rank: rankOf(e, "importer") }))
			.filter((e) => e.rank >= 0)
			.sort(compareSearchHit)
			.map((e) => e.name);
		assert.deepEqual(sorted, [
			"Importer",
			"Flomo Importer",
			"Style Importer",
			"JSON-CSV Importer",
			"Wikidata Importer",
			"Tolino notes Importer",
			"Kobo Highlights Importer",
			"Pocketbook Cloud Highlight Importer",
		]);
	});

	await test("ordering ignores manifest order and is repeatable", () => {
		const entries = [
			{ name: "Zeta Git", id: "zeta-git", author: "a", desc: "" },
			{ name: "Git", id: "git", author: "a", desc: "" },
			{ name: "Alpha Git", id: "alpha-git", author: "a", desc: "" },
			{ name: "Git Tools", id: "git-tools", author: "a", desc: "" },
		].map((e) => ({ ...e, rank: rankOf(e, "git") }));
		const once = entries.slice().sort(compareSearchHit).map((e) => e.name);
		const twice = entries.slice().reverse().sort(compareSearchHit).map((e) => e.name);
		assert.deepEqual(once, ["Git", "Git Tools", "Zeta Git", "Alpha Git"]);
		assert.deepEqual(twice, once);
	});

	await test("sort: name / downloads / updated, missing data last, ties keep order", () => {
		const hits = [
			{ name: "Beta", id: "b", rank: 2 },
			{ name: "Alpha", id: "a", rank: 2 },
			{ name: "Gamma", id: "c", rank: 1 },
			{ name: "NoMeta", id: "d", rank: 2 },
		];
		const stats = new Map([
			["a", { downloads: 10, updated: "2025-01-01" }],
			["b", { downloads: 300, updated: "2024-06-01" }],
			["c", { downloads: 300, updated: "2026-10-20" }],
		]);
		const statOf = (h) => stats.get(h.id) ?? {};
		const names = (sort) => sortSearchHits(hits, sort, statOf).map((h) => h.name);
		// 名称：纯本地字母序
		assert.deepEqual(names("name"), ["Alpha", "Beta", "Gamma", "NoMeta"]);
		// 热门：下载量降序；同值保持传入次序（Beta 在 Gamma 前）；缺数据排最后
		assert.deepEqual(names("downloads"), ["Beta", "Gamma", "Alpha", "NoMeta"]);
		// 最近更新：时间降序；缺数据排最后
		assert.deepEqual(names("updated"), ["Gamma", "Alpha", "Beta", "NoMeta"]);
	});

	console.log(`\nsearch-rank-smoke: ${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exitCode = 1;
	}
} finally {
	await rm(tempDir, { recursive: true, force: true });
}
