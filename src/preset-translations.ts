import { requestUrl } from "obsidian";

import { MIRRORS } from "./mirror";
import { withTimeout } from "./util";

/** 预置简翻数据外置在公开仓 raw 文件；不占用 plugin release/tag，避免干扰更新检查。 */
const PRESET_URL =
	"https://raw.githubusercontent.com/jiaoyingxing/openplug/main/data/preset-translations.json";
const CACHE_KEY = "openplug-preset-translations-v1";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

interface PresetPayload {
	version?: string;
	entries?: Record<string, unknown>;
}

interface CachedPayload {
	at: number;
	entries: Record<string, string>;
}

let translations: Map<string, string> | null = null;
let cacheLoaded = false;
let loadPromise: Promise<void> | null = null;

function readCache(): CachedPayload | null {
	try {
		const raw = window.localStorage.getItem(CACHE_KEY);
		if (!raw) {
			return null;
		}
		const data = JSON.parse(raw) as Partial<CachedPayload>;
		if (
			typeof data.at !== "number"
			|| !data.entries
			|| typeof data.entries !== "object"
		) {
			return null;
		}
		const entries: Record<string, string> = {};
		for (const [id, value] of Object.entries(data.entries)) {
			if (typeof value === "string" && value.trim()) {
				entries[id] = value.trim();
			}
		}
		return { at: data.at, entries };
	} catch {
		return null;
	}
}

function ensureCacheLoaded(): void {
	if (cacheLoaded) {
		return;
	}
	cacheLoaded = true;
	const cached = readCache();
	if (cached) {
		translations = new Map(Object.entries(cached.entries));
	}
}

function firstSuccess(tasks: Array<Promise<PresetPayload>>): Promise<PresetPayload> {
	return new Promise((resolve, reject) => {
		let failed = 0;
		for (const task of tasks) {
			task.then(resolve, () => {
				failed += 1;
				if (failed === tasks.length) {
					reject(new Error("预置翻译全部源均失败"));
				}
			});
		}
	});
}

async function fetchPreset(): Promise<PresetPayload> {
	const urls = [PRESET_URL, ...MIRRORS.map((mirror) => mirror.prefix + PRESET_URL)];
	return firstSuccess(
		urls.map(async (url) => {
			const res = await withTimeout(
				requestUrl({ url }),
				FETCH_TIMEOUT_MS,
			);
			if (res.status >= 300) {
				throw new Error(`HTTP ${res.status}`);
			}
			return res.json as PresetPayload;
		}),
	);
}

/** 视图渲染只读内存表；缓存同步加载，首次安装无缓存时返回 null。 */
export function getPresetTranslation(id: string): string | null {
	ensureCacheLoaded();
	return translations?.get(id) ?? null;
}

/** 启动/打开视图时后台刷新；同轮请求去重，失败保留旧缓存。 */
export async function loadPresetTranslations(): Promise<void> {
	ensureCacheLoaded();
	const cached = readCache();
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
		return;
	}
	if (loadPromise) {
		return loadPromise;
	}
	loadPromise = (async () => {
		try {
			const data = await fetchPreset();
			const entries: Record<string, string> = {};
			for (const [id, value] of Object.entries(data.entries ?? {})) {
				if (typeof value === "string" && value.trim()) {
					entries[id] = value.trim();
				}
			}
			if (Object.keys(entries).length === 0) {
				return;
			}
			translations = new Map(Object.entries(entries));
			try {
				window.localStorage.setItem(
					CACHE_KEY,
					JSON.stringify({ at: Date.now(), entries }),
				);
			} catch {
				// 缓存写入失败不影响本次会话查表
			}
		} catch {
			// 网络失败保留旧缓存；无缓存则本次不显示预置译文
		}
	})().finally(() => {
		loadPromise = null;
	});
	return loadPromise;
}
