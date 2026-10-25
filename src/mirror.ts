import { apiVersion, App, requestUrl } from "obsidian";

import { PROBE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, withTimeout } from "./util";
import {
	compareNumericVersions,
	isStableVersion,
	parseJsDelivrVersionList,
	parseManifestVersion,
	parseVersionRequirements,
	pickLatestStableVersion,
	pickUpdateTarget,
	resolveInstallableVersion,
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
/** 详情版本列表：jsDelivr 失败后仍要尽快给出 GitHub tags 兜底。 */
const PICKER_VERSION_TIMEOUT_MS = 10_000;
/** 同一插件短时间重复打开详情时复用版本列表，避免反复触发兜底竞速。 */
const PICKER_VERSIONS_CACHE_TTL_MS = 10 * 60 * 1000;
const PICKER_VERSIONS_CACHE_LIMIT = 50;
const pickerVersionsCache = new Map<
	string,
	{ versions: string[]; at: number }
>();

/** 可装版本表（versions.json）是可选文件：取不到时按 manifest 版本回退，
 * 不阻塞详情；短时缓存同时服务详情卡与更新检查。 */
const COMPAT_TIMEOUT_MS = 5000;
const VERSION_REQUIREMENTS_CACHE_TTL_MS = 10 * 60 * 1000;
const VERSION_REQUIREMENTS_CACHE_LIMIT = 50;
const versionRequirementsCache = new Map<
	string,
	{ requirements: Record<string, string>; at: number }
>();

export interface PluginInfo extends PluginInfoBase {
	/** 本机可装版本：与 version 相同，或按 versions.json 回退到当前宿主能
	 * 装的最高版。详情卡与默认安装都以它为准（官方同口径）。 */
	installVersion: string;
	installMinAppVersion: string;
}

interface PluginInfoBase {
	id: string;
	repo: string;
	/** 默认分支 manifest 声明的版本（官方最新发布版）。 */
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

interface ParsedManifest {
	rawManifest: string;
	version: string;
	minAppVersion: string;
	name: string;
	description: string;
	isDesktopOnly: boolean;
}

/** 默认分支 manifest（官方同源：raw HEAD）；id 必须与官方清单一致（官方
 * 详情/更新检查同样校验），不通过时再退 master/main，避免拿到改名前的
 * 旧分支内容（Vtable 的 master 仍是 vtable-plugin / 1.0.2）。 */
async function fetchManifest(
	repo: string,
	prefix: string,
	pluginId: string,
): Promise<ParsedManifest> {
	let lastErr = "";
	for (const branch of ["HEAD", "master", "main"]) {
		try {
			const raw = await getText(
				`${prefix}${RAW_BASE}${repo}/${branch}/manifest.json`,
			);
			const man = JSON.parse(raw) as {
				id?: unknown;
				version?: unknown;
				minAppVersion?: unknown;
				name?: unknown;
				description?: unknown;
				isDesktopOnly?: unknown;
			};
			const version = typeof man.version === "string" ? man.version.trim() : "";
			if (!version) {
				throw new Error("manifest 缺少版本号");
			}
			if (man.id !== pluginId) {
				throw new Error("manifest id 与官方清单不一致");
			}
			return {
				rawManifest: raw,
				version,
				minAppVersion:
					typeof man.minAppVersion === "string" ? man.minAppVersion : "",
				name: typeof man.name === "string" ? man.name : pluginId,
				description: typeof man.description === "string" ? man.description : "",
				isDesktopOnly: man.isDesktopOnly === true,
			};
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
	entry: PluginListItem,
): Promise<{ info: PluginInfoBase; mirror: Mirror }> {
	return (async () => {
		const man = await withTimeout(
			fetchManifest(entry.repo, mirror.prefix, entry.id),
			REQUEST_TIMEOUT_MS,
		);
		return {
			mirror,
			info: {
				id: entry.id,
				repo: entry.repo,
				version: man.version,
				name: man.name,
				author: entry.author,
				description: man.description,
				minAppVersion: man.minAppVersion,
				isDesktopOnly: man.isDesktopOnly,
				rawManifest: man.rawManifest,
			},
		};
	})();
}

function promiseAny<T>(tasks: Array<Promise<T>>): Promise<T> {
	return new Promise((resolve, reject) => {
		let failures = 0;
		for (const task of tasks) {
			task.then(resolve, () => {
				failures += 1;
				if (failures === tasks.length) {
					reject(new Error("全部镜像均失败"));
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

async function fetchVersionRequirementsFrom(
	mirror: Mirror,
	repo: string,
): Promise<Record<string, string>> {
	const res = await withTimeout(
		requestUrl({
			url: `${mirror.prefix}${RAW_BASE}${repo}/HEAD/versions.json`,
		}),
		COMPAT_TIMEOUT_MS,
	);
	if (res.status === 404) {
		// 可选文件：多数插件没有 versions.json，404 视为空表而不是失败，
		// 让镜像竞速按"最先答复"结束，不必等最慢的镜像也 404。
		return {};
	}
	if (res.status >= 300) {
		throw new Error(`HTTP ${res.status}`);
	}
	const requirements = parseVersionRequirements(res.text);
	if (requirements === null) {
		throw new Error("versions.json 解析失败");
	}
	return requirements;
}

/** versions.json（版本 → 最低宿主版本）；可选文件，全部镜像都取不到时按
 * 空表处理（详情与更新检查都回退 manifest 口径）。 */
async function loadVersionRequirements(
	repo: string,
): Promise<Record<string, string>> {
	const cached = versionRequirementsCache.get(repo);
	if (
		cached &&
		Date.now() - cached.at < VERSION_REQUIREMENTS_CACHE_TTL_MS
	) {
		return cached.requirements;
	}
	let requirements: Record<string, string> = {};
	try {
		requirements = await promiseAny(
			MIRRORS.map((mirror) => fetchVersionRequirementsFrom(mirror, repo)),
		);
	} catch {
		requirements = {};
	}
	versionRequirementsCache.set(repo, { requirements, at: Date.now() });
	if (versionRequirementsCache.size > VERSION_REQUIREMENTS_CACHE_LIMIT) {
		const oldest = versionRequirementsCache.keys().next().value;
		if (oldest !== undefined) {
			versionRequirementsCache.delete(oldest);
		}
	}
	return requirements;
}

export async function fetchPluginInfo(
	list: PluginListItem[],
	pluginId: string,
): Promise<{ info: PluginInfo; mirror: Mirror }> {
	const entry = list.find((e) => e.id === pluginId);
	if (!entry) {
		throw new NotFoundError(pluginId);
	}
	const result = await withRetry(() =>
		promiseAny(MIRRORS.map((m) => fetchInfoFrom(m, entry))),
	);
	let requirements: Record<string, string> = {};
	try {
		requirements = await fetchVersionRequirementsFrom(
			result.mirror,
			entry.repo,
		);
	} catch {
		requirements = {};
	}
	const installable = resolveInstallableVersion(
		result.info.version,
		result.info.minAppVersion,
		requirements,
		apiVersion,
	);
	return {
		info: {
			...result.info,
			installVersion: installable.version,
			installMinAppVersion: installable.minAppVersion,
		},
		mirror: result.mirror,
	};
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
async function fetchVersions(
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

/** GitHub tags 兜底；direct + 镜像前缀竞速，兼容移动端直连不可达。 */
async function fetchGitHubTags(repo: string, prefix = ""): Promise<string[]> {
	const res = await withTimeout(
		requestUrl({
			url: `${prefix}https://api.github.com/repos/${repo}/tags?per_page=100`,
		}),
		PICKER_VERSION_TIMEOUT_MS,
	);
	if (res.status >= 300) {
		throw new Error(`HTTP ${res.status}`);
	}
	const data = res.json as Array<{ name?: unknown }> | null;
	if (!Array.isArray(data)) {
		throw new Error("GitHub tags 解析失败");
	}
	return data
		.map((entry) => (typeof entry.name === "string" ? entry.name : ""))
		.filter((name) => name.length > 0);
}

/** 详情安装版本：jsDelivr 失败时退到 GitHub tags（直连 + 镜像竞速）；稳定 tag 优先，最多 15 个。 */
export async function fetchPickerVersions(repo: string): Promise<string[]> {
	const cached = pickerVersionsCache.get(repo);
	if (cached && Date.now() - cached.at < PICKER_VERSIONS_CACHE_TTL_MS) {
		return cached.versions;
	}
	const versions = await loadPickerVersions(repo);
	pickerVersionsCache.set(repo, { versions, at: Date.now() });
	if (pickerVersionsCache.size > PICKER_VERSIONS_CACHE_LIMIT) {
		const oldest = pickerVersionsCache.keys().next().value;
		if (oldest !== undefined) {
			pickerVersionsCache.delete(oldest);
		}
	}
	return versions;
}

async function loadPickerVersions(repo: string): Promise<string[]> {
	try {
		return await fetchVersions(repo, 15, PICKER_VERSION_TIMEOUT_MS);
	} catch {
		const tags = await promiseAny([
			fetchGitHubTags(repo),
			...MIRRORS.map((mirror) => fetchGitHubTags(repo, mirror.prefix)),
		]);
		const seen = new Set<string>();
		const stable: string[] = [];
		const rest: string[] = [];
		for (const tag of tags) {
			if (seen.has(tag)) {
				continue;
			}
			seen.add(tag);
			(isStableVersion(tag) ? stable : rest).push(tag);
		}
		return (stable.length > 0 ? stable : rest).slice(0, 15);
	}
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

interface ManifestMeta {
	version: string;
	minAppVersion: string;
}

async function fetchManifestMetaFromMirror(
	repo: string,
	mirror: Mirror,
): Promise<ManifestMeta> {
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
	const man = JSON.parse(res.text) as { minAppVersion?: unknown };
	return {
		version,
		minAppVersion:
			typeof man.minAppVersion === "string" ? man.minAppVersion : "",
	};
}

/** Mirror-proxied default-branch manifest; races all mirrors and takes the
 * first stable version. Used only when the jsDelivr tag source is unavailable. */
async function fetchManifestMeta(repo: string): Promise<ManifestMeta> {
	return promiseAny(
		MIRRORS.map((mirror) => fetchManifestMetaFromMirror(repo, mirror)),
	);
}

/** 官方插件可更新到的最高稳定版（无则 null）。
 *
 * Primary: jsDelivr tag list (numeric max stable; the list is tag-time
 * descending but not semantically ordered), then versions.json drops versions
 * that explicitly require a newer Obsidian. When data.jsdelivr is unreachable
 * (CN networks, 2026-10-21 batch outage), fall back to the default-branch
 * manifest through the mirror pool; an incompatible manifest version falls
 * back to the highest compatible entry in versions.json. Versions missing from
 * the table are unknown and stay eligible, so a plugin that publishes a tag
 * without bumping its manifest can still be offered during a degraded round.
 * Only checks versions.json when the candidate is actually newer than the
 * installed version. Throws only when every source failed, so the view can
 * count a real failure instead of silently reporting "no updates". */
export async function fetchUpdateTarget(
	repo: string,
	installedVersion: string,
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
			if (!latest) {
				return null;
			}
			if ((compareNumericVersions(latest, installedVersion) ?? 0) <= 0) {
				return latest;
			}
			const requirements = await loadVersionRequirements(repo);
			return pickUpdateTarget(versions, requirements, apiVersion);
		} catch {
			// Fall through to the manifest transport.
		}
	}
	try {
		const man = await fetchManifestMeta(repo);
		reachable = true;
		if ((compareNumericVersions(man.version, installedVersion) ?? 0) <= 0) {
			return man.version;
		}
		const gated = man.minAppVersion
			? pickUpdateTarget(
					[man.version],
					{ [man.version]: man.minAppVersion },
					apiVersion,
				)
			: man.version;
		if (gated !== null) {
			return gated;
		}
		const requirements = await loadVersionRequirements(repo);
		return pickUpdateTarget(
			Object.keys(requirements),
			requirements,
			apiVersion,
		);
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
