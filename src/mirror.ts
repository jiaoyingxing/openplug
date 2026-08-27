import { App, Notice, requestUrl } from "obsidian";

import { PROBE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, withTimeout } from "./util";

export interface Mirror {
	id: string;
	label: string;
	prefix: string;
}

export const MIRRORS: Mirror[] = [
	{ id: "gh-proxy", label: "gh-proxy.com", prefix: "https://gh-proxy.com/" },
	{ id: "ghfast", label: "ghfast.top", prefix: "https://ghfast.top/" },
	{ id: "wget-la", label: "wget.la", prefix: "https://wget.la/" },
	{ id: "idayer", label: "gh.idayer.com", prefix: "https://gh.idayer.com/" },
];

const LIST_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const THEME_LIST_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-css-themes.json";
const RAW_BASE = "https://raw.githubusercontent.com/";

interface ListEntry {
	id: string;
	repo: string;
	author: string;
}

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

function fetchInfoFrom(
	mirror: Mirror,
	pluginId: string,
): Promise<{ info: PluginInfo; mirror: Mirror }> {
	return (async () => {
		const list = JSON.parse(
			await withTimeout(getText(mirror.prefix + LIST_URL), REQUEST_TIMEOUT_MS),
		) as ListEntry[];
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
	new Notice(`已安装并启用主题：${theme.name}`);
}

export async function fetchPluginInfo(
	pluginId: string,
): Promise<{ info: PluginInfo; mirror: Mirror }> {
	return withRetry(() => promiseAny(MIRRORS.map((m) => fetchInfoFrom(m, pluginId))));
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

export async function fetchVersions(repo: string): Promise<string[]> {
	const res = await withTimeout(
		requestUrl({ url: `https://data.jsdelivr.com/v1/package/gh/${repo}` }),
		REQUEST_TIMEOUT_MS,
	);
	if (res.status >= 300) {
		throw new Error(`HTTP ${res.status}`);
	}
	const data = JSON.parse(res.text) as { versions?: string[] };
	const versions = Array.isArray(data.versions) ? data.versions : [];
	return versions.slice(0, 15);
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
	if (!plugins.enabledPlugins.has(info.id)) {
		await plugins.enablePluginAndSave(info.id);
	}
	new Notice(`已安装并启用：${info.name}`);
}
