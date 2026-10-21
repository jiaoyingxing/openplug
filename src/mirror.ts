import { App, requestUrl } from "obsidian";

import { PROBE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, withTimeout } from "./util";
import {
	parseJsDelivrVersionList,
	parseManifestVersion,
	pickLatestStableVersion,
} from "./update-check";

export { compareNumericVersions } from "./update-check";

export interface Mirror {
	id: string;
	label: string;
	prefix: string;
}

export const MIRRORS: Mirror[] = [
	{ id: "gh-proxy", label: "gh-proxy.com", prefix: "https://gh-proxy.com/" },
	{ id: "ghfast", label: "ghfast.top", prefix: "https://ghfast.top/" },
	{ id: "gh-monlor", label: "gh.monlor.com", prefix: "https://gh.monlor.com/" },
	{ id: "wget-la", label: "wget.la", prefix: "https://wget.la/" },
];

const LIST_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const THEME_LIST_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-css-themes.json";
const RAW_BASE = "https://raw.githubusercontent.com/";

/** Update checks use a shorter budget than installs: a dead data API must not
 * hold the whole update list for 30s per plugin. */
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
/** One jsDelivr availability probe per check round; a live endpoint answers in
 * about a second, and the fallback is cheap enough to prefer over a long wait. */
const UPDATE_CHECK_PROBE_TIMEOUT_MS = 5_000;
const UPDATE_CHECK_PROBE_REPO = "jiaoyingxing/openplug";

export interface PluginInfo {
	id: string;
	repo: string;
	version: string;
	name: string;
	author: string;
	description: string;
	minAppVersion: string;
	isDesktopOnly: boolean;
	rawManifest: string;
}

class NotFoundError extends Error {
	constructor(pluginId: string) {
		super(`官方清单中无此插件：${pluginId}`);
		this.name = "NotFoundError";
	}
}

export interface PluginListItem {
	id: string;
	name: string;
	author: string;
	description: string;
	repo: string;
}

async function getText(url: string): Promise<string> {
	const res = await requestUrl({ url });
	if (res.status >= 300) {
		throw new Error(`HTTP ${res.status}`);
	}
	return res.text;
}

async function fetchManifestText(repo: string, prefix: string): Promise<string> {
	let lastErr = "";
	for (const branch of ["master", "main"]) {
		try {
			return await getText(`${prefix}${RAW_BASE}${repo}/${branch}/manifest.json`);
		} catch (e) {
			lastErr = String(e);
		}
	}
	throw new Error(lastErr || "manifest 拉取失败");
}

/** 插件安装目标文件数（installPlugin 的 targets 长度；顶部进度计数用，
	 * 与进度文案「（n/3）」一致）。 */
export const INSTALL_TARGET_FILES = 3;
/** 主题安装进度节拍数（installTheme 的 onProgress 次数）。 */
export const INSTALL_THEME_BEATS = 2;

function fetchInfoFrom(
	mirror: Mirror,
	list: PluginListItem[],
	pluginId: string,
): Promise<{ info: PluginInfo; mirror: Mirror }> {
	return (async () => {
		const entry = list.find((e) => e.id === pluginId);
		if (!entry) {
			throw new NotFoundError(pluginId);
		}
		const rawManifest = await withTimeout(
			fetchManifestText(entry.repo, mirror.prefix),
			REQUEST_TIMEOUT_MS,
		);
		const man = JSON.parse(rawManifest) as Partial<PluginInfo>;
		if (!man.version) {
			throw new Error("manifest 缺少版本号");
		}
		return {
			mirror,
			info: {
				id: pluginId,
				repo: entry.repo,
				version: man.version,
				name: man.name ?? pluginId,
				author: entry.author,
				description: man.description ?? "",
				minAppVersion: man.minAppVersion ?? "",
				isDesktopOnly: man.isDesktopOnly ?? false,
				rawManifest,
			},
		};
	})();
}

function promiseAny<T>(tasks: Array<Promise<T>>): Promise<T> {
	return new Promise((resolve, reject) => {
		const errors: unknown[] = [];
		let failures = 0;
		for (const task of tasks) {
			task.then(resolve, (e) => {
				errors.push(e);
				failures += 1;
				if (failures === tasks.length) {
					if (errors.every((x) => x instanceof NotFoundError)) {
						reject(errors[0]);
					} else {
						reject(new Error("全部镜像均失败"));
					}
				}
			});
		}
	});
}

async function withRetry<T>(fn: () => Promise<T>, times = 2): Promise<T> {
	let last: unknown;
	for (let i = 0; i <= times; i++) {
		try {
			return await fn();
		} catch (e) {
			last = e;
			if (e instanceof NotFoundError) {
				throw e;
			}
			if (i < times) {
				await new Promise((r) => window.setTimeout(r, 800));
			}
		}
	}
	throw last instanceof Error ? last : new Error(String(last));
}

export async function fetchPluginList(): Promise<PluginListItem[]> {
	return withRetry(() => promiseAny(MIRRORS.map((m) => getPluginListFrom(m))));
}

async function getPluginListFrom(mirror: Mirror): Promise<PluginListItem[]> {
	const txt = await withTimeout(getText(mirror.prefix + LIST_URL), REQUEST_TIMEOUT_MS);
	if (!txt.trim()) {
		throw new Error("空列表");
	}
	return JSON.parse(txt) as PluginListItem[];
}

export interface ThemeListItem {
	name: string;
	author: string;
	repo: string;
	modes?: string[];
}

export async function fetchThemeList(): Promise<ThemeListItem[]> {
	return withRetry(() => promiseAny(MIRRORS.map((m) => getThemeListFrom(m))));
}

async function getThemeListFrom(mirror: Mirror): Promise<ThemeListItem[]> {
	const txt = await withTimeout(
		getText(mirror.prefix + THEME_LIST_URL),
		REQUEST_TIMEOUT_MS,
	);
	if (!txt.trim()) {
		throw new Error("空列表");
	}
	return JSON.parse(txt) as ThemeListItem[];
}

function themeBranchOrder(branch?: string): string[] {
	const set = new Set<string>(["master", "main"]);
	if (branch) {
		set.add(branch);
	}
	return Array.from(set);
}

async function downloadFromRepo(
	repo: string,
	file: string,
	branch?: string,
): Promise<ArrayBuffer | null> {
	for (const b of themeBranchOrder(branch)) {
		try {
			const buf = await downloadCrossChecked(`${RAW_BASE}${repo}/${b}/${file}`);
			if (buf) {
				return buf;
			}
		} catch {
			// 尝试下一个分支
		}
	}
	return null;
}

export async function installTheme(
	app: App,
	theme: ThemeListItem,
	onProgress: (file: string) => void,
): Promise<void> {
	const dir = `${app.vault.configDir}/themes/${theme.name}`;
	await app.vault.adapter.mkdir(dir);

	onProgress("theme.css");
	const css = await downloadFromRepo(theme.repo, "theme.css");
	if (!css) {
		throw new Error("下载 theme.css 失败");
	}
	await app.vault.adapter.writeBinary(`${dir}/theme.css`, css);

	// 第二个进度节拍（视图按 2 个文件计数，见 doInstallTheme）
	onProgress("manifest.json");
	try {
		const man = await downloadFromRepo(theme.repo, "manifest.json");
		if (man) {
			await app.vault.adapter.writeBinary(`${dir}/manifest.json`, man);
		}
	} catch {
		// manifest 可选
	}

	await (
		app.vault as unknown as {
			setConfig(key: string, value: string): Promise<void>;
		}
	).setConfig("cssTheme", theme.name);
}

export async function fetchPluginInfo(
	list: PluginListItem[],
	pluginId: string,
): Promise<{ info: PluginInfo; mirror: Mirror }> {
	return withRetry(() => promiseAny(MIRRORS.map((m) => fetchInfoFrom(m, list, pluginId))));
}

export interface MirrorProbe {
	mirror: Mirror;
	ms: number | null;
}

export async function probeMirrorsHealth(): Promise<MirrorProbe[]> {
	return Promise.all(
		MIRRORS.map(async (mirror): Promise<MirrorProbe> => {
			const start = performance.now();
			try {
				await withTimeout(getText(mirror.prefix + LIST_URL), PROBE_TIMEOUT_MS);
				return { mirror, ms: Math.round(performance.now() - start) };
			} catch {
				return { mirror, ms: null };
			}
		}),
	);
}

/** jsDelivr 版本列表（按 tag 时间倒序、含预发布）。官方已弃用单数端点
 * v1/package/gh（响应头 Deprecation: 2023-01-01，successor-version 指向
 * v1/packages/gh），故用复数端点；条目为 {version,...} 对象数组，缺
 * version 的畸形条目过滤而非崩溃。 */
export async function fetchVersions(
	repo: string,
	maxVersions = 15,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<string[]> {
	const res = await withTimeout(
		requestUrl({ url: `https://data.jsdelivr.com/v1/packages/gh/${repo}` }),
		timeoutMs,
	);
	if (res.status >= 300) {
		throw new Error(`HTTP ${res.status}`);
	}
	const versions = parseJsDelivrVersionList(res.text);
	if (versions === null) {
		throw new Error("版本列表解析失败");
	}
	return versions.slice(0, maxVersions);
}

/** 已安装插件版本快照（更新检测输入；插件目录里有 manifest 就算已安装）。 */
export interface InstalledPluginCheck {
	id: string;
	version: string;
}

/** 检测出的可更新项：官方清单内插件 + 最新稳定版数字版本高于本机版本。 */
export interface PluginUpdateEntry {
	id: string;
	name: string;
	author: string;
	repo: string;
	installedVersion: string;
	latestVersion: string;
}

// Version parsing/comparison lives in ./update-check (pure, host-free).

let updateCheckProbe: Promise<boolean> | null = null;

/** Re-probe on each update-check round (view open / retry); one probe result
 * is shared by every plugin in that round. */
export function resetUpdateCheckSourceProbe(): void {
	updateCheckProbe = null;
}

function isDataApiAvailable(): Promise<boolean> {
	if (updateCheckProbe === null) {
		updateCheckProbe = (async () => {
			try {
				const versions = await fetchVersions(
					UPDATE_CHECK_PROBE_REPO,
					1,
					UPDATE_CHECK_PROBE_TIMEOUT_MS,
				);
				return versions.length > 0;
			} catch {
				return false;
			}
		})();
	}
	return updateCheckProbe;
}

async function fetchManifestVersionFromMirror(
	repo: string,
	mirror: Mirror,
): Promise<string> {
	const res = await withTimeout(
		requestUrl({ url: `${mirror.prefix}${RAW_BASE}${repo}/HEAD/manifest.json` }),
		UPDATE_CHECK_TIMEOUT_MS,
	);
	if (res.status >= 300) {
		throw new Error(`HTTP ${res.status}`);
	}
	const version = parseManifestVersion(res.text);
	if (!version) {
		throw new Error("manifest 缺少稳定版本号");
	}
	return version;
}

/** Mirror-proxied default-branch manifest; races all mirrors and takes the
 * first stable version. Used only when the jsDelivr tag source is unavailable. */
export async function fetchManifestVersion(repo: string): Promise<string> {
	return promiseAny(
		MIRRORS.map((mirror) => fetchManifestVersionFromMirror(repo, mirror)),
	);
}

/** 官方插件最新稳定发布版（无则 null）。
 *
 * Primary: jsDelivr tag list (numeric max stable; the list is tag-time
 * descending but not semantically ordered). When data.jsdelivr is unreachable
 * (CN networks, 2026-10-21 batch outage), fall back to the default-branch
 * manifest through the mirror pool. The manifest path matches what the host
 * reads, but a plugin that publishes a tag without bumping its manifest can be
 * missed during the degraded round; that trade-off is recorded in DECISIONS.
 * Throws only when every source failed, so the view can count a real failure
 * instead of silently reporting "no updates". */
export async function fetchLatestStableVersion(
	repo: string,
): Promise<string | null> {
	let reachable = false;
	if (await isDataApiAvailable()) {
		try {
			const versions = await fetchVersions(
				repo,
				200,
				UPDATE_CHECK_TIMEOUT_MS,
			);
			reachable = true;
			const latest = pickLatestStableVersion(versions);
			if (latest) {
				return latest;
			}
		} catch {
			// Fall through to the manifest transport.
		}
	}
	try {
		const latest = await fetchManifestVersion(repo);
		reachable = true;
		return latest;
	} catch {
		// Fall through to the failure decision below.
	}
	if (!reachable) {
		throw new Error("update-check-sources-unavailable");
	}
	return null;
}

async function sha256(buf: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", buf);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function downloadCrossChecked(url: string): Promise<ArrayBuffer | null> {
	const settled = await Promise.allSettled(
		MIRRORS.map(async (mirror) => {
			const res = await withTimeout(
				requestUrl({ url: mirror.prefix + url }),
				REQUEST_TIMEOUT_MS,
			);
			if (res.status >= 300) {
				throw new Error(`HTTP ${res.status}`);
			}
			const ab = res.arrayBuffer;
			return { ab, hash: await sha256(ab) };
		}),
	);
	const ok: Array<{ ab: ArrayBuffer; hash: string }> = [];
	for (const s of settled) {
		if (s.status === "fulfilled") {
			ok.push(s.value);
		}
	}
	if (ok.length === 0) {
		return null;
	}
	const hashes = new Set(ok.map((o) => o.hash));
	if (hashes.size > 1) {
		throw new Error(`多镜像校验不一致：${url}`);
	}
	return ok[0].ab;
}

export async function installPlugin(
	app: App,
	info: PluginInfo,
	onProgress: (file: string) => void,
	versionOverride?: string,
): Promise<void> {
	const version = versionOverride || info.version;
	const releaseBase = `https://github.com/${info.repo}/releases/download/${version}`;
	const targets: Array<{ file: string; url: string; required: boolean }> = [
		{ file: "main.js", url: `${releaseBase}/main.js`, required: true },
		{
			file: "manifest.json",
			url: `${releaseBase}/manifest.json`,
			required: false,
		},
		{
			file: "styles.css",
			url: `${releaseBase}/styles.css`,
			required: false,
		},
	];

	const dir = `${app.vault.configDir}/plugins/${info.id}`;
	// 安装前目录已有 manifest = 更新/重装：保持用户当前的启停状态，绝不
	// 擅自启用原本未启用的插件（2026-08-30 用户要求）；仅全新安装自动
	// 启用（对应按钮语义「下载安装并启用」）。必须在本操作写任何文件
	// 之前判定（写在后面会因 manifest 已写入而恒为 true）。
	const wasInstalled = await app.vault.adapter.exists(`${dir}/manifest.json`);
	await app.vault.adapter.mkdir(dir);

	for (const target of targets) {
		onProgress(target.file);
		try {
			const buf = await downloadCrossChecked(target.url);
			if (buf) {
				await app.vault.adapter.writeBinary(`${dir}/${target.file}`, buf);
				continue;
			}
			if (target.required) {
				throw new Error(`下载失败：${target.file}`);
			}
		} catch (e) {
			if (target.required) {
				throw e;
			}
			continue;
		}
	}

	if (!(await app.vault.adapter.exists(`${dir}/manifest.json`))) {
		await app.vault.adapter.write(`${dir}/manifest.json`, info.rawManifest);
	}

	// 上游发布包内 manifest 的 version 可能滞后于 release tag（如 dataview
	// 0.5.70 资产仍标注 0.5.68，2026-08-31 取证；宿主与本插件均按 manifest
	// 判定已安装版本），导致永久显示旧版本并反复提示可更新。落盘后把
	// version 对齐请求版本，其余字段保持官方资产原样。
	const manifestPath = `${dir}/manifest.json`;
	if (await app.vault.adapter.exists(manifestPath)) {
		try {
			const man = JSON.parse(await app.vault.adapter.read(manifestPath)) as {
				version?: string;
			};
			if (man.version !== version) {
				man.version = version;
				await app.vault.adapter.write(
					manifestPath,
					JSON.stringify(man, null, "\t"),
				);
			}
		} catch {
			// manifest 不可解析时保持原样，不做兜底改写
		}
	}

	const plugins = (
		app as unknown as {
			plugins: {
				loadManifests(): Promise<void>;
				enablePluginAndSave(id: string): Promise<void>;
				enabledPlugins: Map<string, boolean>;
			};
		}
	).plugins;
	await plugins.loadManifests();
	if (!wasInstalled && !plugins.enabledPlugins.has(info.id)) {
		await plugins.enablePluginAndSave(info.id);
	}
}
