import { requestUrl } from "obsidian";

import { withTimeout } from "./util";

/** 官方社区目录的公开搜索接口（官网前端同源），只取公开目录数据。 */
const STORE_ENDPOINT =
	"https://community.obsidian.md/api/search/collections/entries/documents/search";
/** 搜索 key 由官网页面内嵌下发；每次会话取一次，401 时重取。 */
const STORE_KEY_PAGE = "https://community.obsidian.md/search?type=plugin";
const STORE_TIMEOUT_MS = 15_000;
export const STORE_PAGE_SIZE = 12;
/** 紧急总开关：关闭后商店只显示不可用提示，搜索 / 安装 / 更新不受影响。 */
export const STORE_ONLINE_ENABLED = true;

const FACETS_TTL_MS = 24 * 60 * 60 * 1000;

/** 官方首页的 8 个分类标签；facet 取不到时仍可用的最小集合。 */
const DEFAULT_CATEGORY_SLUGS = [
	"integrations",
	"files",
	"ai",
	"sidebar",
	"editing",
	"visualization",
	"automation",
	"links",
];

/** 官方分类元数据（图标为 Lucide 名，可直接交给 setIcon）。 */
const CATEGORY_META: Record<string, { label: string; icon: string }> = {
	ai: { label: "AI", icon: "bot" },
	annotation: { label: "标注", icon: "highlighter" },
	appearance: { label: "外观", icon: "palette" },
	attachments: { label: "附件", icon: "paperclip" },
	audio: { label: "音频", icon: "audio-lines" },
	autocomplete: { label: "自动补全", icon: "text-cursor-input" },
	automation: { label: "自动化", icon: "workflow" },
	backup: { label: "备份", icon: "archive" },
	bases: { label: "Bases（数据库）", icon: "layout-list" },
	calendar: { label: "日历", icon: "calendar" },
	canvas: { label: "白板", icon: "layout-dashboard" },
	charts: { label: "图表", icon: "chart-column" },
	code: { label: "代码", icon: "code" },
	collaboration: { label: "协作", icon: "users-round" },
	commands: { label: "命令", icon: "command" },
	css: { label: "CSS", icon: "file-code" },
	csv: { label: "CSV", icon: "file-spreadsheet" },
	data: { label: "数据", icon: "database" },
	dates: { label: "日期", icon: "calendar-days" },
	developers: { label: "开发者", icon: "terminal" },
	drawing: { label: "绘图", icon: "line-squiggle" },
	editing: { label: "编辑", icon: "pen-line" },
	emoji: { label: "Emoji", icon: "smile" },
	export: { label: "导出", icon: "upload" },
	files: { label: "文件", icon: "file" },
	finance: { label: "财务", icon: "dollar-sign" },
	flashcards: { label: "闪卡", icon: "layers" },
	folders: { label: "文件夹", icon: "folder-open" },
	fonts: { label: "字体", icon: "book-type" },
	footnotes: { label: "脚注", icon: "asterisk" },
	formats: { label: "文件格式", icon: "files" },
	formatting: { label: "文字排版", icon: "heading-1" },
	git: { label: "Git", icon: "git-branch" },
	graph: { label: "关系图谱", icon: "network" },
	hotkeys: { label: "快捷键", icon: "keyboard" },
	html: { label: "HTML", icon: "code-xml" },
	icons: { label: "图标", icon: "shapes" },
	images: { label: "图片", icon: "image" },
	import: { label: "导入", icon: "download" },
	integrations: { label: "第三方集成", icon: "openplug-blocks" },
	interface: { label: "界面", icon: "monitor" },
	json: { label: "JSON", icon: "braces" },
	languages: { label: "翻译与多语言", icon: "languages" },
	latex: { label: "LaTeX", icon: "sigma" },
	links: { label: "链接", icon: "link" },
	markdown: { label: "Markdown", icon: "file-text" },
	math: { label: "数学", icon: "calculator" },
	music: { label: "音乐", icon: "music" },
	navigation: { label: "导航", icon: "binoculars" },
	ocr: { label: "OCR", icon: "scan-text" },
	outlining: { label: "大纲", icon: "list-tree" },
	pdf: { label: "PDF", icon: "file-pen" },
	"project-management": { label: "项目管理", icon: "kanban" },
	properties: { label: "属性", icon: "info" },
	publishing: { label: "发布", icon: "send" },
	research: { label: "研究", icon: "microscope" },
	review: { label: "复习与回顾", icon: "clipboard-check" },
	rtl: { label: "RTL 文字支持", icon: "signpost" },
	science: { label: "科学", icon: "flask-conical" },
	search: { label: "搜索", icon: "search" },
	sidebar: { label: "侧边栏", icon: "panel-left" },
	snippets: { label: "代码片段", icon: "scissors" },
	"status-bar": { label: "状态栏", icon: "panel-bottom" },
	syncing: { label: "同步", icon: "refresh-cw" },
	syntax: { label: "语法高亮", icon: "hash" },
	tables: { label: "表格", icon: "table" },
	tags: { label: "标签", icon: "tag" },
	tasks: { label: "任务", icon: "square-check" },
	templating: { label: "模板", icon: "files" },
	theming: { label: "主题", icon: "paintbrush" },
	thinking: { label: "思维工具", icon: "brain" },
	ttrpg: { label: "跑团", icon: "dices" },
	utilities: { label: "实用工具", icon: "wrench" },
	video: { label: "视频", icon: "video" },
	vim: { label: "Vim", icon: "text-cursor" },
	visualization: { label: "可视化", icon: "chart-pie" },
	workspaces: { label: "工作区", icon: "panels-top-left" },
	writing: { label: "写作", icon: "pen-tool" },
};

export type StoreSort = "downloads" | "updated" | "name";

export interface StoreDetailMeta {
	downloads: string;
	updated: string;
	/** 原始值只给直搜排序用；界面展示仍走上面两条格式化文本。 */
	downloadsValue?: number;
	updatedValue?: string;
}

export interface CategoryOption {
	slug: string;
	label: string;
	icon: string;
	count: number | null;
}

export interface StoreHitDocument {
	slug?: string;
	name?: string;
	authors?: string[];
	short_desc?: string;
	downloads?: number;
	latest_release_at?: string;
}

interface StoreResponse {
	found?: number;
	hits?: Array<{ document?: StoreHitDocument }>;
	facet_counts?: Array<{
		counts?: Array<{ value?: string; count?: number }>;
	}>;
}

export interface StorePage {
	found: number;
	hits: Array<{ document?: StoreHitDocument }>;
}

const SORT_BY: Record<StoreSort, string> = {
	downloads: "downloads:desc",
	updated: "latest_release_at(missing_values: last):desc",
	name: "name:asc",
};

let cachedKey: string | null = null;
let keyPromise: Promise<string> | null = null;
let facetsCache: { options: CategoryOption[]; at: number } | null = null;
let facetsPromise: Promise<CategoryOption[]> | null = null;
const META_CACHE_TTL_MS = 10 * 60 * 1000;
const META_CACHE_MAX = 50;
const metaCache = new Map<
	string,
	{ metas: Map<string, StoreDetailMeta>; at: number }
>();

function getCategoryMeta(slug: string): { label: string; icon: string } {
	return CATEGORY_META[slug] ?? { label: slug, icon: "tag" };
}

/** facet 未返回时的默认 8 个官方分类；与 DEFAULT_CATEGORY_SLUGS 单一事实源。 */
export function buildDefaultCategoryOptions(): CategoryOption[] {
	return DEFAULT_CATEGORY_SLUGS.map((slug) => {
		const meta = getCategoryMeta(slug);
		return { slug, label: meta.label, icon: meta.icon, count: null };
	});
}

function buildCategoryOptions(
	facets: Array<{ value: string; count: number }> = [],
): CategoryOption[] {
	const counts = new Map(facets.map((facet) => [facet.value, facet.count]));
	const slugs = counts.size > 0 ? Array.from(counts.keys()) : DEFAULT_CATEGORY_SLUGS;
	return slugs
		.map((slug) => {
			const meta = getCategoryMeta(slug);
			return {
				slug,
				label: meta.label,
				icon: meta.icon,
				count: counts.get(slug) ?? null,
			};
		})
		.sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.label.localeCompare(b.label, "zh-CN"));
}

async function getApiKey(force = false): Promise<string> {
	if (force) {
		cachedKey = null;
		keyPromise = null;
	}
	if (cachedKey) {
		return cachedKey;
	}
	if (!keyPromise) {
		keyPromise = (async () => {
			const res = await withTimeout(
				requestUrl({ url: STORE_KEY_PAGE }),
				STORE_TIMEOUT_MS,
			);
			if (res.status >= 300) {
				throw new Error(`HTTP ${res.status}`);
			}
			const match = res.text.match(
				/apiKey[^A-Za-z0-9+/=]+([A-Za-z0-9+/=]{40,})/,
			);
			if (!match) {
				throw new Error("未找到商店搜索密钥");
			}
			cachedKey = match[1];
			return cachedKey;
		})().finally(() => {
			keyPromise = null;
		});
	}
	return keyPromise;
}

async function requestStore(
	params: Record<string, string>,
): Promise<StoreResponse> {
	const query = new URLSearchParams(params).toString();
	const url = `${STORE_ENDPOINT}?${query}`;
	let retried = false;
	for (;;) {
		const key = await getApiKey(retried);
		const res = await withTimeout(
			requestUrl({
				url,
				headers: { "X-TYPESENSE-API-KEY": key },
			}),
			STORE_TIMEOUT_MS,
		);
		if ((res.status === 401 || res.status === 403) && !retried) {
			retried = true;
			continue;
		}
		if (res.status >= 300) {
			throw new Error(`HTTP ${res.status}`);
		}
		return res.json as StoreResponse;
	}
}

function buildFilter(tags: string[]): string {
	let filter = "type:=plugin";
	if (tags.length === 1) {
		filter += ` && tags:=${tags[0]}`;
	} else if (tags.length > 1) {
		filter += ` && tags:=[${tags.join(",")}]`;
	}
	return filter;
}

export async function fetchStorePage(
	tags: string[],
	sort: StoreSort,
	page: number,
): Promise<StorePage> {
	const data = await requestStore({
		q: "*",
		query_by: "name",
		filter_by: buildFilter(tags),
		sort_by: SORT_BY[sort],
		per_page: String(STORE_PAGE_SIZE),
		page: String(page),
	});
	return { found: data.found ?? 0, hits: data.hits ?? [] };
}

export async function fetchStoreFacets(): Promise<CategoryOption[]> {
	if (facetsCache && Date.now() - facetsCache.at < FACETS_TTL_MS) {
		return facetsCache.options;
	}
	if (!facetsPromise) {
		facetsPromise = (async () => {
			const data = await requestStore({
				q: "*",
				query_by: "name",
				filter_by: "type:=plugin",
				facet_by: "tags",
				max_facet_values: "200",
				per_page: "1",
			});
			const counts = (data.facet_counts?.[0]?.counts ?? [])
				.map((facet) => ({
					value: facet.value ?? "",
					count: facet.count ?? 0,
				}))
				.filter((facet) => facet.value.length > 0);
			const options = buildCategoryOptions(counts);
			facetsCache = { options, at: Date.now() };
			return options;
		})().finally(() => {
			facetsPromise = null;
		});
	}
	return facetsPromise;
}

/**
 * 按查询词调官方搜索接口（名称/简介/作者多字段），把命中文档按 slug 归成
 * 下载量 + 上次更新元数据；顶部搜索行回填与详情卡补行共用。官方接口无按
 * slug 过滤能力（slug 非索引字段），只能按词检索后按 slug 匹配；结果按词
 * 缓存 10 分钟，接口失败抛错由调用方降级。
 */
export async function fetchStoreMetaForQuery(
	query: string,
): Promise<Map<string, StoreDetailMeta>> {
	const key = query.trim().toLowerCase();
	if (!key) {
		return new Map();
	}
	const cached = metaCache.get(key);
	if (cached && Date.now() - cached.at < META_CACHE_TTL_MS) {
		return cached.metas;
	}
	const data = await requestStore({
		q: key,
		query_by: "name,short_desc,authors",
		filter_by: buildFilter([]),
		per_page: "50",
		page: "1",
	});
	const metas = new Map<string, StoreDetailMeta>();
	for (const hit of data.hits ?? []) {
		const doc = hit.document;
		if (!doc?.slug) {
			continue;
		}
		metas.set(doc.slug, {
			downloads:
				typeof doc.downloads === "number"
					? formatDownloads(doc.downloads)
					: "",
			updated: formatUpdated(doc.latest_release_at),
			downloadsValue:
				typeof doc.downloads === "number" ? doc.downloads : undefined,
			updatedValue: doc.latest_release_at,
		});
	}
	if (metaCache.size >= META_CACHE_MAX) {
		const oldest = metaCache.keys().next().value;
		if (oldest !== undefined) {
			metaCache.delete(oldest);
		}
	}
	metaCache.set(key, { metas, at: Date.now() });
	return metas;
}

export function formatDownloads(downloads: number): string {
	if (!Number.isFinite(downloads) || downloads <= 0) {
		return "0";
	}
	if (downloads >= 100_000_000) {
		return `${(downloads / 100_000_000).toFixed(1).replace(/\.0$/, "")} 亿`;
	}
	if (downloads >= 10_000) {
		return `${(downloads / 10_000).toFixed(1).replace(/\.0$/, "")} 万`;
	}
	return downloads.toLocaleString("zh-CN");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 商店接口给 ISO 时间；按本地日历日解析，日期-only 值不走 UTC 偏移。 */
function parseUpdatedDate(value: string): Date | null {
	const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateOnly) {
		const date = new Date(
			Number(dateOnly[1]),
			Number(dateOnly[2]) - 1,
			Number(dateOnly[3]),
		);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

/** 上次更新时间：本地日历日差 → 今天 / 昨天 / N天前 / N个月前 / N年前。 */
export function formatUpdated(value?: string): string {
	if (!value) {
		return "";
	}
	const date = parseUpdatedDate(value);
	if (!date) {
		return value.slice(0, 10);
	}
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const days = Math.round((today.getTime() - date.getTime()) / DAY_MS);
	if (days <= 0) {
		return "今天";
	}
	if (days === 1) {
		return "昨天";
	}
	if (days < 30) {
		return `${days}天前`;
	}
	if (days < 365) {
		return `${Math.max(1, Math.floor(days / 30))}个月前`;
	}
	return `${Math.max(1, Math.floor(days / 365))}年前`;
}

export { getCategoryMeta };
