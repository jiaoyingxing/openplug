#!/usr/bin/env node
/**
 * OpenPlug 更新检查解析/选择行为钉（2026-10-21，data.jsdelivr CN 网络不可用轮）。
 *
 * 钉面：
 * 1. 稳定版判定拒绝预发布；
 * 2. 数值比较剥离预发布/构建后缀、缺段补零，口径与宿主一致；
 * 3. 最新稳定版取数值最高项，不假设列表顺序；
 * 4. manifest 与 jsDelivr 载荷的畸形输入降级为 null/[]，不抛错。
 *
 * 纯模块 src/update-check.ts 不引 obsidian；用 esbuild 打成临时 ESM 后导入。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "openplug-update-check-"));
const outfile = path.join(tempDir, "update-check.mjs");

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
		entryPoints: [path.join(root, "src", "update-check.ts")],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2020",
		outfile,
		logLevel: "silent",
	});
	const {
		isStableVersion,
		compareNumericVersions,
		pickLatestStableVersion,
		parseManifestVersion,
		parseJsDelivrVersionList,
	} = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);

	await test("stable versions are dotted numeric only", () => {
		assert.equal(isStableVersion("0.3.4"), true);
		assert.equal(isStableVersion("1.5"), true);
		assert.equal(isStableVersion("2.27.0-beta.8"), false);
		assert.equal(isStableVersion("latest"), false);
	});

	await test("numeric comparison strips prerelease suffixes and pads missing segments", () => {
		assert.equal(compareNumericVersions("2.27.0", "2.27.0-beta.8"), 0);
		assert.equal(compareNumericVersions("1.4.10", "1.4.9"), 1);
		assert.equal(compareNumericVersions("1.4.9", "1.4.10"), -1);
		assert.equal(compareNumericVersions("1.5", "1.4.9"), 1);
		assert.equal(compareNumericVersions("1.2.x", "1.2.0"), null);
	});

	await test("latest stable is the numeric max, not the first list entry", () => {
		assert.equal(
			pickLatestStableVersion(["2.27.0-beta.8", "1.2.0", "1.1.5", "1.2.1"]),
			"1.2.1",
		);
		assert.equal(pickLatestStableVersion([]), null);
		assert.equal(pickLatestStableVersion(["nightly", "1.0.0-rc1"]), null);
	});

	await test("manifest payload accepts stable version only", () => {
		assert.equal(parseManifestVersion(JSON.stringify({ version: "0.3.4" })), "0.3.4");
		assert.equal(parseManifestVersion(JSON.stringify({ version: "0.3.4-beta" })), null);
		assert.equal(parseManifestVersion("not-json"), null);
		assert.equal(parseManifestVersion("{}"), null);
	});

	await test("jsDelivr payload filters malformed entries; malformed JSON returns null", () => {
		assert.deepEqual(
			parseJsDelivrVersionList(
				JSON.stringify({
					versions: [null, {}, { version: "0.3.2" }, { version: 3 }, { version: "0.3.4" }],
				}),
			),
			["0.3.2", "0.3.4"],
		);
		assert.equal(parseJsDelivrVersionList("not-json"), null);
		assert.equal(parseJsDelivrVersionList(JSON.stringify({ versions: "x" })), null);
	});

	console.log(`\nupdate-check-smoke: ${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exitCode = 1;
	}
} finally {
	await rm(tempDir, { recursive: true, force: true });
}
