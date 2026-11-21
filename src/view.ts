import { ItemView, Notice, SearchComponent, setIcon } from "obsidian";

import { VIEW_TYPE_PICKER } from "./consts";
import { openForumView } from "./forum-view";
import { createPager, PagerHandle } from "./pager";
import { getPresetTranslation } from "./preset-translations";
import { readLocalCache, writeLocalCache } from "./local-cache";
import {
	compareSearchHit,
	SearchSort,
	searchHitRank,
	sortSearchHits,
} from "./search-rank";
import { fetchStoreMetaForQuery, StoreDetailMeta } from "./store";
import { StoreSection } from "./store-view";
import { translateTextCached } from "./translate";
import { openExternal } from "./util";
import {
	compareNumericVersions,
	fetchPluginInfo,
	fetchPluginList,
	fetchThemeList,
	fetchPickerVersions,
	fetchUpdateTarget,
	installPlugin,
	installTheme,
	INSTALL_TARGET_FILES,
	INSTALL_THEME_BEATS,
	InstalledPluginCheck,
	PluginInfo,
	PluginListItem,
	PluginUpdateEntry,
	resetUpdateCheckSourceProbe,
	ThemeListItem,
} from "./mirror";

type SearchKind = "plugin" | "theme";

/** 搜索输入防抖：避免逐字重渲染与重复请求。 */
const SEARCH_DEBOUNCE_MS = 250;

/** 成功状态行各自消失前的停留时间：完成一条即开始计时，不等待整批结束
 * （2026-11-11 用户要求 2 秒）。 */
const BANNER_SUCCESS_TTL_MS = 2000;

/** 更新列表每页条数：行含名称 + 作者 + 版本，单页 5 条保持板块紧凑
 * （2026-10-25 用户要求复用商店翻页结构，单页 5-6 条）。 */
const UPDATES_PAGE_SIZE = 5;

/** 本插件自身的官方清单 id：它出现在更新列表里时固定排在最前
 * （2026-10-25 用户要求）。 */
const SELF_PLUGIN_ID = "openplug";

/** 官方社区官网（主页社区卡三步引导第一步链接与收合后的「查看」共用）。 */
const COMMUNITY_URL = "https://community.obsidian.md/";

/** 社区卡引导收合标记：三步引导点过「明白」后按库记住，重开安装器仍是
 * 双行入口形态（2026-11-21 社区卡合并后沿用原键）。 */
const COMMUNITY_GUIDE_KEY = "openplug-community-guide-dismissed";

/** 跨会话缓存键（IndexedDB，见 `src/local-cache.ts`）。官方清单 3.2MB，
 * 冷启动重下会在宿主启动窗口里占掉数秒，故落盘复用。 */
const PLUGIN_LIST_CACHE_KEY = "plugin-list-v1";
const THEME_LIST_CACHE_KEY = "theme-list-v1";
/** 更新检查的「每插件最新稳定版」缓存（TTL 1h，与内存表同口径）。 */
const UPDATE_CACHE_KEY = "update-latest-v1";
/** 缓存视为新鲜的时长：期内冷启动直接用落盘清单、完全不联网。取 6 小时是
 * 速度与新鲜度的折中——每天常用也只会后台刷新 2–4 次，新上架插件最多滞后
 * 半天；超过此期仍先用手上这份（stale-while-revalidate），不设硬失效，
 * 避免离线时清单整个消失。 */
const LIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CachedList<T> {
	at: number;
	items: T[];
}

/** 落盘数据来自上一个会话，按结构校验后再用；形状不符就当没缓存。 */
function isUsableCachedList<T>(
	cached: { at?: unknown; items?: unknown } | null,
	isItem: (item: unknown) => boolean,
): cached is CachedList<T> {
	if (!cached || typeof cached.at !== "number" || !Array.isArray(cached.items)) {
		return false;
	}
	if (cached.items.length === 0) {
		return false;
	}
	// 抽查首尾两条即可：整表来自同一次 JSON.parse，局部损坏概率可忽略
	const items = cached.items;
	return isItem(items[0]) && isItem(items[items.length - 1]);
}

function isPluginListItem(item: unknown): boolean {
	const entry = item as Partial<PluginListItem> | null;
	return (
		!!entry
		&& typeof entry.id === "string"
		&& typeof entry.name === "string"
		&& typeof entry.repo === "string"
	);
}

function isThemeListItem(item: unknown): boolean {
	const entry = item as Partial<ThemeListItem> | null;
	return (
		!!entry
		&& typeof entry.name === "string"
		&& typeof entry.repo === "string"
	);
}

type BannerState = "is-loading" | "is-success" | "is-error";

/** 主页「作者精选」条目：只给官方清单 id 与用户给定的名称/介绍，版本、
 * 作者等元数据不展示；安装走官方清单 + 现役安装主链。 */
interface AuthorPick {
	id: string;
	name: string;
	desc: string;
}

/** 主页「作者精选」常驻推荐（2026-10-25 用户给定文稿，文案不改写；
 * 2026-11-20 追加 Storage Cleanup，介绍取自其 README 首段）。
 * 已安装的条目由 renderAuthorPicks 过滤，不在版面出现。 */
const AUTHOR_PICKS: ReadonlyArray<AuthorPick> = [
	{
		id: "obsidian-importer",
		name: "Importer",
		desc: "Obsidian 官方推出的笔记迁移工具，轻松将 Notion、OneNote、Bear（熊掌记）、Evernote（印象笔记）、Apple Notes（iOS 备忘录）等主流笔记平台的数据完整迁移到 Obsidian 知识库。",
	},
	{
		id: "easy-sync",
		name: "EasySync",
		desc: "在电脑、手机和平板之间轻松同步 Obsidian 仓库。具备冲突识别、进度可视化、云端回收站、历史版本、自动同步等功能，支持同步插件。不设服务器，无需复杂配置，登录 OneDrive 直接同步。",
	},
	{
		id: "resojot",
		name: "Resojot",
		desc: "在 Obsidian 里轻松完成录音、转写和整理，让语音内容更快变成可查、可用的笔记。会议、课堂、奇思妙想，一键录好，随时翻找。",
	},
	{
		id: "yolo",
		name: "YOLO",
		desc: "完整的 Agent 体验。不止回答问题。YOLO 能理解并操作你的笔记仓库，调用工具与 MCP，并通过 Skills 按你的方式完成任务。桌面端还能一键切到你已登录的受支持 CLI Agent（Codex/Claude Code），让它直接在仓库里工作。",
	},
	{
		id: "storage-cleanup",
		name: "Storage Cleanup",
		desc: "像查看手机、电脑的「存储空间」一样，一眼看清仓库里每个文件占了多少空间。按类目查看内容、.trash 和插件数据的占用，安全清理大文件、空文件，并清空 .trash 回收站。",
	},
];

/** 顶部状态行句柄：并发操作各占一行、互不覆盖；close() 移除该行。 */
interface BannerLine {
	update(text: string, state: BannerState): void;
	close(): void;
}

/**
 * 插件级安装通道：同一插件同时只保留一条状态行与一条下载链。
 * 获取信息阶段 `version`/`promise` 为空；`users` 统计引用该通道的
 * 进行中操作数（含获取信息阶段），归零即注销。
 */
interface PluginInstallTask {
	line: BannerLine;
	version: string | null;
	promise: Promise<void> | null;
	users: number;
}

interface SearchResult {
	kind: SearchKind;
	id: string;
	name: string;
	author: string;
	desc: string;
	/** 命中档位：越小越"硬"（0 名称全等 … 5 仅简介命中）。 */
	rank: number;
}

/** 一行直搜结果：行元素 + 元数据行元素（主题没有元数据行），供排序后原位重排。 */
interface SearchRow {
	result: SearchResult;
	el: HTMLElement;
	metaEl: HTMLElement | null;
}

export class OpenplugPickerView extends ItemView {
	private _versionSelect: HTMLSelectElement | null = null;
	private _searchEl: HTMLInputElement | null = null;
	private _searchComponent: SearchComponent | null = null;
	private _searchDebounceTimer: number | null = null;
	private _bodyEl: HTMLElement | null = null;
	private _rootEl: HTMLElement | null = null;
	private _bannerEl: HTMLElement | null = null;
	private _storeAddHost: HTMLElement | null = null;
	private _storeSection: StoreSection | null = null;
	private _listCache: PluginListItem[] | null = null;
	private _themeListCache: ThemeListItem[] | null = null;
	/** 清单加载单飞：并发调用共享同一轮请求，失败后下次重试（两条清单各自独立）。 */
	private _pluginListPromise: Promise<void> | null = null;
	private _themeListPromise: Promise<void> | null = null;
	/** 更新检测的最新版本缓存（TTL 内不重复请求 jsDelivr；键 = 插件 id）。
	 * 冷启动从 IndexedDB 预载（见 `_preloadUpdateCache`），TTL 内整轮更新
	 * 检查零网络请求——此前该缓存只在内存，每次冷启动都要重打 12+ 个
	 * jsDelivr 请求（实测 0.9–1.8s）。 */
	private _updateLatestCache = new Map<string, { latest: string; at: number }>();
	private static readonly _UPDATE_CACHE_TTL_MS = 60 * 60 * 1000;
	/** 落盘写回状态：脏标记 + 合并写（一次检查会连查多个插件）。 */
	private _updateCacheDirty = false;
	private _updateCacheWriteQueued = false;
	/** 主页重建竞态序号：搜索/关闭等动作重建主页后，旧检测结果不得写 DOM。 */
	private _updatesSeq = 0;
	/** 更新板块结果壳：行区 + 常驻翻页条；翻页只重绘行区（焦点不丢）。 */
	private _updatesShell: {
		section: HTMLElement;
		list: HTMLElement;
		pager: PagerHandle;
	} | null = null;
	/** 本轮检测结果与当前页：更新成功即从结果集移除并重绘，页码随条数收敛。 */
	private _updatesData: PluginUpdateEntry[] = [];
	private _updatesFailed = 0;
	private _updatesPage = 1;
	/** 「作者精选」重建竞态序号：主页重建后旧的已安装判定不得写 DOM。 */
	private _picksSeq = 0;
	/** 直搜排序单选：与分类筛选的排序同一组选项，只在搜索态占据顶部行右侧。 */
	private _searchSort: SearchSort = "downloads";
	private _searchSortHost: HTMLElement | null = null;
	/** 最近一次搜索的官方元数据（按查询词）：有缓存时排序可同步生效，不必先按相关度再跳。 */
	private _searchMetaCache: { query: string; metas: Map<string, StoreDetailMeta> } | null = null;
	/** 插件级下载通道（键 = 插件 id）：同插件不并发下载，也只占一条状态行。 */
	private _pluginInstallTasks = new Map<string, PluginInstallTask>();

	getViewType(): string {
		return VIEW_TYPE_PICKER;
	}

	getDisplayText(): string {
		return "OpenPlug 插件 / 主题安装";
	}

	getIcon(): string {
		return "shopping-cart";
	}

	async onOpen(): Promise<void> {
		this._ensureLayout();
		if (this._bodyEl) {
			this._renderEmptyState(this._bodyEl);
		}
		void this._ensureLists();
		// 更新检查的版本缓存与界面并行预载：主页首绘不等它，检查本身等。
		void this._preloadUpdateCache();
	}

	/**
	 * 更新检查的版本缓存预载（冷启动零网络的关键）：上次会话写下的
	 * 「每插件最新稳定版」在 TTL 内直接复用，整轮检查不再请求 jsDelivr。
	 * 与 `_ensureLists` 并行起跑，更新检查 await 到即用。
	 */
	private _updateCacheReady: Promise<void> | null = null;

	private _preloadUpdateCache(): Promise<void> {
		if (!this._updateCacheReady) {
			this._updateCacheReady = readLocalCache<
				Record<string, { latest: string; at: number }>
			>(UPDATE_CACHE_KEY).then((stored) => {
				if (!stored) {
					return;
				}
				const now = Date.now();
				for (const [id, entry] of Object.entries(stored)) {
					if (
						entry
						&& typeof entry.latest === "string"
						&& typeof entry.at === "number"
						&& now - entry.at < OpenplugPickerView._UPDATE_CACHE_TTL_MS
					) {
						// 内存里已有的（本会话已查过）优先，不被旧落盘覆盖
						if (!this._updateLatestCache.has(id)) {
							this._updateLatestCache.set(id, { latest: entry.latest, at: entry.at });
						}
					}
				}
				// 预载完成时若本轮尚无新查询（dirty 仍为 false），落盘内容与内存一致；
				// 若已有新结果进来，dirty 保持，由合并写回把整表刷下去。
				if (!this._updateCacheDirty) {
					this._updateCacheWriteQueued = false;
				}
			});
		}
		return this._updateCacheReady;
	}

	/**
	 * 回写版本缓存：整轮检查中会连续查询多个插件，故合并到微任务之后写一次；
	 * 落盘内容是内存表全量，晚写的覆盖早写的，不会丢条目。
	 */
	private _persistUpdateCache(): void {
		if (this._updateCacheWriteQueued) {
			return;
		}
		this._updateCacheWriteQueued = true;
		void Promise.resolve().then(() => {
			this._updateCacheWriteQueued = false;
			if (!this._updateCacheDirty) {
				return;
			}
			this._updateCacheDirty = false;
			const plain: Record<string, { latest: string; at: number }> = {};
			for (const [id, entry] of this._updateLatestCache) {
				plain[id] = entry;
			}
			void writeLocalCache(UPDATE_CACHE_KEY, plain);
		});
	}

	async onClose(): Promise<void> {
		if (this._searchDebounceTimer !== null) {
			window.clearTimeout(this._searchDebounceTimer);
			this._searchDebounceTimer = null;
		}
		this._storeSection?.dispose();
		this._storeSection = null;
		this._updatesShell = null;
		this.contentEl.empty();
		this._rootEl = null;
		this._searchEl = null;
		this._searchComponent = null;
		this._storeAddHost = null;
		this._searchSortHost = null;
		this._searchMetaCache = null;
		this._bodyEl = null;
	}

	private _ensureLayout(): void {
		if (this._searchEl && this._bodyEl) {
			return;
		}
		this.contentEl.empty();
		this._rootEl = this.contentEl.createDiv({ cls: "op-root" });
		const topbar = this._rootEl.createDiv({ cls: "op-topbar" });
		const topRow = topbar.createDiv({ cls: "op-top-row" });
		const searchWrap = topRow.createDiv({ cls: "op-search-wrap" });
		const search = new SearchComponent(searchWrap);
		search.setPlaceholder("搜索插件名 / 主题名 / 作者…");
		search.inputEl.setAttribute("aria-label", "搜索插件名、主题名或作者");
		this._searchComponent = search;
		this._searchEl = search.inputEl;
		search.onChange(() => {
			if (this._searchDebounceTimer !== null) {
				window.clearTimeout(this._searchDebounceTimer);
			}
			this._searchDebounceTimer = window.setTimeout(() => {
				this._searchDebounceTimer = null;
				void this._onSearchInput();
			}, SEARCH_DEBOUNCE_MS);
		});
		this._storeAddHost = topRow.createDiv();
		// 直搜与分类筛选互斥：同一个右侧槽位，搜索时有字就换成排序单选
		// （2026-10-25 用户定；选项与分类筛选的排序同一组）。
		this._searchSortHost = topRow.createDiv({
			cls: "op-search-sort is-hidden",
		});
		const sortEl = this._searchSortHost.createEl("select", {
			cls: "dropdown",
			attr: { "aria-label": "排序" },
		});
		for (const [value, label] of [
			["downloads", "热门"],
			["updated", "最近更新"],
			["name", "名称"],
		] as const) {
			sortEl.createEl("option", { value, text: label });
		}
		sortEl.value = this._searchSort;
		sortEl.addEventListener("change", () => {
			this._searchSort = sortEl.value as SearchSort;
			void this._onSearchInput();
		});
		this._bannerEl = topbar.createDiv({ cls: "op-banner is-hidden" });
		this._bodyEl = this._rootEl.createDiv({ cls: "op-body" });
	}

	private _bannerLine(): BannerLine {
		const el = this._bannerEl;
		if (!el) {
			return { update: () => {}, close: () => {} };
		}
		// 新开操作：清掉已完结历史行（进行中的并发行原样保留）
		this._bannerSweepFinished();
		const line = el.createDiv({ cls: "op-banner-line is-loading" });
		el.classList.remove("is-hidden");
		let closed = false;
		let successTimer: number | null = null;
		const closeLine = (): void => {
			if (closed) {
				return;
			}
			closed = true;
			if (successTimer !== null) {
				window.clearTimeout(successTimer);
				successTimer = null;
			}
			line.remove();
			this._recomputeBanner();
		};
		this._recomputeBanner();
		return {
			update: (text, state) => {
				if (closed) {
					return;
				}
				line.setText(text);
				// is-success / is-error 只作状态语义（计时消解与保留逻辑用），
				// 无对应样式；is-loading 有浅色底与动效样式。
				line.classList.toggle("is-loading", state === "is-loading");
				// 成功行各自计时：完成一条就独立消失，不等待整批结束；失败行
				// 保留，供用户回看原因。
				if (state === "is-success" && successTimer === null) {
					successTimer = window.setTimeout(() => {
						successTimer = null;
						closeLine();
					}, BANNER_SUCCESS_TTL_MS);
				}
				this._recomputeBanner();
			},
			close: closeLine,
		};
	}

	/** 依据现存状态行重算壳体：任意加载中 → is-loading（横移动效）；
	 * 无行 → 隐藏。 */
	private _recomputeBanner(): void {
		const el = this._bannerEl;
		if (!el) {
			return;
		}
		const children = Array.from(el.children);
		el.classList.toggle(
			"is-loading",
			children.some((c) => c.classList.contains("is-loading")),
		);
		el.classList.toggle("is-hidden", children.length === 0);
	}

	/** 清掉已完结（成功/失败）的历史行，避免壳体堆积；加载中的行保留——
	 * 返回首页只是离开当前视图，不得切断进行中任务的可见状态（2026-09-15
	 * 用户反馈：关闭详情/重新搜索不等于结束下载任务）。 */
	private _bannerSweepFinished(): void {
		const el = this._bannerEl;
		if (!el) {
			return;
		}
		for (const child of Array.from(el.children)) {
			if (!child.classList.contains("is-loading")) {
				child.remove();
			}
		}
		this._recomputeBanner();
	}

	/**
	 * 取得插件级安装通道：同一插件的详情安装、更新行、作者精选共用一条
	 * 状态行与在途下载。重复触发不再各开一条队列（2026-11-14 用户反馈：
	 * 同一插件三行「正在下载」并行）。
	 */
	private _acquirePluginTask(id: string): PluginInstallTask {
		let task = this._pluginInstallTasks.get(id);
		if (!task) {
			task = {
				line: this._bannerLine(),
				version: null,
				promise: null,
				users: 0,
			};
			this._pluginInstallTasks.set(id, task);
		}
		task.users += 1;
		return task;
	}

	/** 操作结束归还通道；最后一个引用离开即注销。状态行不在此关闭：
	 * 成功行按 TTL 自行消解，失败行保留供回看。 */
	private _releasePluginTask(id: string, task: PluginInstallTask): void {
		task.users -= 1;
		if (task.users > 0) {
			return;
		}
		if (this._pluginInstallTasks.get(id) === task) {
			this._pluginInstallTasks.delete(id);
		}
	}

	/**
	 * 登记实际下载：同版本直接并入在途任务（`joined`，无新状态行、无第二
	 * 次镜像请求）；不同版本排到在途任务之后，保证同一插件的写入顺序。
	 * 返回的 promise 由调用方 await，结算后再归还通道。
	 */
	private _queuePluginInstall(
		task: PluginInstallTask,
		info: PluginInfo,
		version: string,
		progressText: (done: number) => string,
	): { promise: Promise<void>; joined: boolean } {
		if (task.promise) {
			if (task.version === version) {
				return { promise: task.promise, joined: true };
			}
			const prior = task.promise.catch(() => {});
			let done = 0;
			const queued = prior.then(() =>
				installPlugin(
					this.app,
					info,
					() => {
						done += 1;
						task.line.update(progressText(done), "is-loading");
					},
					version,
				),
			);
			task.version = version;
			task.promise = queued;
			return { promise: queued, joined: false };
		}
		let done = 0;
		task.line.update(progressText(0), "is-loading");
		const promise = installPlugin(
			this.app,
			info,
			() => {
				done += 1;
				task.line.update(progressText(done), "is-loading");
			},
			version,
		);
		task.version = version;
		task.promise = promise;
		return { promise, joined: false };
	}

	private _renderEmptyState(container: HTMLElement): void {
		container.empty();
		// 首页每次重建都是一轮新的已装判定：让「更新」与「作者精选」共用
		// 本轮的一次枚举，但不跨轮沿用（插件可能在别处被装/删）。
		this._invalidateInstalledCache();
		const wrap = container.createDiv({ cls: "op-empty" });
		const store = this._ensureStoreSection();
		if (this._storeAddHost) {
			store.mountAddButton(this._storeAddHost);
		}
		const storeResultsEl = wrap.createDiv({
			cls: "op-store-anchor",
		});
		store.mountResults(storeResultsEl);
		// 顶部社区卡：官方社区与中文论坛合成一张卡，外层标题与描述句取消
		// （2026-11-21 用户定稿）。首次使用在「官方社区」行内嵌三步引导
		// （2026-08-30 三句定稿原文不动），点「明白」就地收合为双行入口
		// 并按库记忆；收合态每行只有行名 +「查看」。
		this._renderCommunityCard(wrap);
		// 底部「插件更新」：标题在壳外（设置页观感），卡内只放检查状态与行。
		// 打开即自动检查（TTL 缓存兜底，决策见 DECISIONS「更新检测」）。
		wrap.createDiv({ cls: "op-heading", text: "插件更新" });
		const updatesEl = wrap.createDiv({ cls: "op-updates" });
		void this._checkAndRenderUpdates(updatesEl);
		// 「作者精选」放在「插件更新」之后：常驻推荐，已安装的条目不出现
		// （全部已安装则标题与卡一起不出现）；已安装判定完成后才落笔。
		void this._renderAuthorPicks(wrap);
	}

	/** 主页社区组卡：官方社区与中文论坛两条目共居一张组卡，对齐宿主
	 * setting-group 形态（组卡无内距，条目自带 20px 内距，条目间分隔线
	 * 两端内缩；2026-11-21 用户对照官方设置截图两轮确认）。首次使用
	 * 「官方社区」条目内嵌三步引导 +「明白」，点后就地换成入口行并按库
	 * 记忆；引导态入口是第一步内链接，不放「查看」按钮，三句沿用
	 * 2026-08-30 定稿原文。 */
	private _renderCommunityCard(wrap: HTMLElement): void {
		const card = wrap.createDiv({ cls: "op-setting-items" });
		const fillRow = (
			row: HTMLElement,
			name: string,
			label: string,
			open: () => void,
		): void => {
			const info = row.createDiv({ cls: "op-update-info" });
			info.createDiv({ cls: "op-update-name", text: name });
			const btn = row.createEl("button", {
				cls: "op-update-btn",
				text: "查看",
			});
			// label 显式传字面量而非模板拼接：verify:runtime 对定稿词逐字断言
			btn.setAttribute("aria-label", label);
			btn.addEventListener("click", open);
		};
		const entryRow = (
			name: string,
			label: string,
			open: () => void,
		): void => {
			fillRow(card.createDiv({ cls: "op-setting-row" }), name, label, open);
		};
		let collapsed = false;
		try {
			collapsed = this.app.loadLocalStorage(COMMUNITY_GUIDE_KEY) === true;
		} catch {
			// 读取失败按未收合处理
		}
		if (collapsed) {
			entryRow("官方社区", "查看官方社区", () => {
				openExternal(COMMUNITY_URL);
			});
			entryRow("中文论坛", "查看中文论坛", () => {
				void openForumView(this.app);
			});
			return;
		}
		const guide = card.createDiv({ cls: "op-community-guide" });
		guide.createDiv({ cls: "op-update-name", text: "官方社区" });
		const ol = guide.createEl("ol", { cls: "op-steps" });
		// 5 句压缩为 3 句编号（2026-08-30 用户要求）：1+2 融合浏览/筛选，
		// 4 + 附注融合完成/搜索替代；官方社区链接、Add to Obsidian 语义
		// 与核心流程不减。第一步单独构建以嵌入官方社区链接；后两步按
		// 顺序追加。
		const first = ol.createEl("li");
		first.append("打开 ");
		const communityLink = first.createEl("a", {
			text: "Obsidian 官方社区",
			href: COMMUNITY_URL,
		});
		communityLink.addEventListener("click", (e) => {
			e.preventDefault();
			openExternal(COMMUNITY_URL);
		});
		first.append("，筛选并找到你需要的插件或主题");
		for (const s of [
			'进入插件/主题页面，点击“Add to Obsidian”',
			"在浏览器中同意打开 Obsidian，回到本面板后点击安装按钮完成安装",
		]) {
			ol.createEl("li", { text: s });
		}
		const row = guide.createDiv({ cls: "op-guide-dismiss-row" });
		const btn = row.createEl("button", {
			cls: "op-update-btn",
			text: "明白",
		});
		btn.setAttribute("aria-label", "明白了，收起官方社区说明");
		btn.addEventListener("click", () => {
			try {
				this.app.saveLocalStorage(COMMUNITY_GUIDE_KEY, true);
			} catch {
				// 写入失败仍就地收合，下次打开会重新展开
			}
			// 就地换成入口条目：清空引导内容、换条目类、补入口行（同卡同
			// 位置，不整页重渲染）；中文论坛条目不受影响。
			guide.empty();
			guide.removeClass("op-community-guide");
			guide.addClass("op-setting-row");
			fillRow(guide, "官方社区", "查看官方社区", () => {
				openExternal(COMMUNITY_URL);
			});
		});
		entryRow("中文论坛", "查看中文论坛", () => {
			void openForumView(this.app);
		});
	}
	private _ensurePluginList(): Promise<void> {
		if (this._listCache) {
			return Promise.resolve();
		}
		if (!this._pluginListPromise) {
			this._pluginListPromise = this._loadPluginList().finally(() => {
				this._pluginListPromise = null;
			});
		}
		return this._pluginListPromise;
	}

	/**
	 * 清单加载（stale-while-revalidate）：先取 IndexedDB 里的上次成功结果
	 * 立刻可用，再按新鲜度决定是否后台拉新版。官方清单 3.2MB（10,666 条），
	 * 冷启动每次重下会在宿主启动窗口里占掉数秒；TTL 内直接用缓存、不联网。
	 *
	 * 只在「本次没有任何缓存」时才等网络（首次安装 / 缓存被清），失败仍由
	 * 调用方显示错误态；有缓存时网络失败保留旧清单，本次照常可用。
	 */
	private async _loadPluginList(): Promise<void> {
		let freshCache = false;
		if (!this._listCache) {
			const cached = await readLocalCache<CachedList<PluginListItem>>(
				PLUGIN_LIST_CACHE_KEY,
			);
			if (cached && isUsableCachedList<PluginListItem>(cached, isPluginListItem)) {
				this._listCache = cached.items;
				freshCache = Date.now() - cached.at < LIST_CACHE_TTL_MS;
			}
		}
		if (freshCache) {
			return;
		}
		const refresh = fetchPluginList()
			.then((list) => {
				if (list.length > 0) {
					this._listCache = list;
					void writeLocalCache(PLUGIN_LIST_CACHE_KEY, {
						at: Date.now(),
						items: list,
					} satisfies CachedList<PluginListItem>);
				}
			})
			.catch(() => {
				// 有缓存时保留旧清单；无缓存时由调用方显示错误态
			});
		if (this._listCache) {
			void refresh;
			return;
		}
		await refresh;
	}

	private _ensureThemeList(): Promise<void> {
		if (this._themeListCache) {
			return Promise.resolve();
		}
		if (!this._themeListPromise) {
			this._themeListPromise = this._loadThemeList().finally(() => {
				this._themeListPromise = null;
			});
		}
		return this._themeListPromise;
	}

	/** 主题清单同插件清单走 stale-while-revalidate（185KB，量小但同源同策）。 */
	private async _loadThemeList(): Promise<void> {
		let freshCache = false;
		if (!this._themeListCache) {
			const cached = await readLocalCache<CachedList<ThemeListItem>>(
				THEME_LIST_CACHE_KEY,
			);
			if (cached && isUsableCachedList<ThemeListItem>(cached, isThemeListItem)) {
				this._themeListCache = cached.items;
				freshCache = Date.now() - cached.at < LIST_CACHE_TTL_MS;
			}
		}
		if (freshCache) {
			return;
		}
		const refresh = fetchThemeList()
			.then((list) => {
				if (list.length > 0) {
					this._themeListCache = list;
					void writeLocalCache(THEME_LIST_CACHE_KEY, {
						at: Date.now(),
						items: list,
					} satisfies CachedList<ThemeListItem>);
				}
			})
			.catch(() => {
				// 同上
			});
		if (this._themeListCache) {
			void refresh;
			return;
		}
		await refresh;
	}

	/** 主页预拉与搜索共用：两条清单并行加载，任一失败不影响另一条。 */
	private _ensureLists(): Promise<void> {
		return Promise.all([
			this._ensurePluginList(),
			this._ensureThemeList(),
		]).then(() => undefined);
	}

	private _ensureStoreSection(): StoreSection {
		if (!this._storeSection) {
			this._storeSection = new StoreSection(
				this.app,
				(id, meta) => {
					void this._openPluginFromStore(id, meta);
				},
			);
		}
		return this._storeSection;
	}

	/** 商店行进入详情：先确保本地清单已就绪，再复用现役 loadFor 主链。 */
	private async _openPluginFromStore(
		id: string,
		meta: StoreDetailMeta,
	): Promise<void> {
		if (!this._listCache) {
			const line = this._bannerLine();
			line.update("正在加载列表…", "is-loading");
			await this._ensurePluginList();
			line.close();
		} else {
			await this._ensurePluginList();
		}
		if (!this._listCache?.some((entry) => entry.id === id)) {
			new Notice("本地清单尚未同步，请稍后重试");
			return;
		}
		await this.loadFor(id, meta);
	}

	private async _onSearchInput(): Promise<void> {
		this._ensureLayout();
		const body = this._bodyEl;
		const q = (this._searchEl?.value ?? "").trim().toLowerCase();
		if (!body) {
			return;
		}
		if (!q) {
			this._storeSection?.setSearchActive(false);
			this._setSearchChrome(false);
			body.empty();
			this._renderEmptyState(body);
			return;
		}
		this._storeSection?.setSearchActive(true);
		this._setSearchChrome(true);
		if (!this._listCache || !this._themeListCache) {
			body.empty();
			// 列表加载的临时文本并入顶部状态行（2026-08-30 用户要求
			// 「临时文本归拢统一」）。
			const line = this._bannerLine();
			line.update("正在加载列表…", "is-loading");
			await this._ensureLists();
			if (!this._listCache && !this._themeListCache) {
				body.empty();
				line.update("列表加载失败，请稍后重试。", "is-error");
				return;
			}
			line.close();
		}
		const hits: SearchResult[] = [];
		if (this._listCache) {
			for (const e of this._listCache) {
				const rank = searchHitRank(
					e.name.toLowerCase(),
					e.author.toLowerCase(),
					e.id.toLowerCase(),
					e.description.toLowerCase(),
					q,
				);
				if (rank >= 0) {
					hits.push({
						kind: "plugin",
						id: e.id,
						name: e.name,
						author: e.author,
						desc: e.description,
						rank,
					});
				}
			}
		}
		if (this._themeListCache) {
			for (const e of this._themeListCache) {
				const rank = searchHitRank(
					e.name.toLowerCase(),
					e.author.toLowerCase(),
					e.repo.toLowerCase(),
					"",
					q,
				);
				if (rank >= 0) {
					hits.push({
						kind: "theme",
						id: e.name,
						name: e.name,
						author: e.author,
						desc: e.repo,
						rank,
					});
				}
			}
		}
		// 初始次序 = 相关度（档位 → 名称长度 → 名称序），插件在前、主题在后；
		// 再按顶部排序单选改写组内次序（元数据未到位时先按相关度，回来后再重排）。
		const relevant = [
			...hits.filter((r) => r.kind === "plugin").sort(compareSearchHit),
			...hits.filter((r) => r.kind === "theme").sort(compareSearchHit),
		];
		const cachedMetas =
			this._searchMetaCache?.query === q ? this._searchMetaCache.metas : null;
		const results = this._orderSearchResults(relevant, cachedMetas);
		body.empty();
		if (results.length === 0) {
			body.createEl("p", { text: "未找到匹配的插件或主题。", cls: "op-muted" });
			return;
		}
		const rows: SearchRow[] = [];
		for (const r of results.slice(0, 50)) {
			const row = body.createDiv({ cls: "op-result" });
			const titleRow = row.createDiv({ cls: "op-result-head" });
			titleRow.createDiv({ text: r.name, cls: "op-result-name" });
			titleRow.createDiv({
				text: r.kind === "theme" ? "主题" : "插件",
				cls: "op-result-tag",
			});
			if (r.kind === "plugin") {
				// 与商店行同构：作者/下载量/上次更新一行，简介与译文各自成行；
				// 元数据异步回填，接口不可用时保持仅作者（与旧行为一致）。
				const metaLine = row.createDiv({
					text: r.author,
					cls: "op-result-desc",
				});
				rows.push({ result: r, el: row, metaEl: metaLine });
				row.createDiv({ text: r.desc, cls: "op-result-desc" });
			} else {
				row.createDiv({
					text: `${r.author} · ${r.desc}`,
					cls: "op-result-desc",
				});
				rows.push({ result: r, el: row, metaEl: null });
			}
			if (r.kind === "plugin") {
				const preset = getPresetTranslation(r.id);
				if (preset) {
					row.createDiv({
						cls: "op-result-trans op-desc-trans",
						text: preset,
					});
				}
			}
			row.addEventListener("click", () => {
				if (r.kind === "plugin") {
					void this.loadFor(r.id);
				} else {
					void this.loadTheme(r.id);
				}
			});
		}
		if (rows.length > 0) {
			void this._enrichSearchMeta(q, rows);
		}
	}

	/** 直搜态顶部行：直搜与分类筛选互斥，同一个槽位在「分类筛选」与排序单选之间切换。 */
	private _setSearchChrome(active: boolean): void {
		this._storeAddHost?.toggleClass("is-hidden", active);
		this._searchSortHost?.toggleClass("is-hidden", !active);
	}

	/** 直搜排序：插件、主题分组内各自排，不互相穿插；热门/最近更新用官方元数据，
	 * 缺数据的排最后并保留相关度次序。 */
	private _orderSearchResults(
		results: SearchResult[],
		metas: Map<string, StoreDetailMeta> | null,
	): SearchResult[] {
		const statOf = (r: SearchResult): { downloads?: number; updated?: string } => {
			const meta = metas?.get(r.id);
			return { downloads: meta?.downloadsValue, updated: meta?.updatedValue };
		};
		const byKind = (kind: SearchKind): SearchResult[] =>
			sortSearchHits(
				results.filter((r) => r.kind === kind),
				this._searchSort,
				statOf,
			);
		return [...byKind("plugin"), ...byKind("theme")];
	}

	/** 顶部搜索行回填官方下载量/上次更新：一次查询批量按 slug 匹配；失败静默。 */
	private async _enrichSearchMeta(
		query: string,
		rows: SearchRow[],
	): Promise<void> {
		let metas: Map<string, StoreDetailMeta>;
		try {
			metas = await fetchStoreMetaForQuery(query);
		} catch {
			return;
		}
		this._searchMetaCache = { query, metas };
		for (const row of rows) {
			const meta = metas.get(row.result.id);
			if (!meta || !row.metaEl?.isConnected) {
				continue;
			}
			const parts = [row.result.author];
			if (meta.downloads) {
				parts.push(`${meta.downloads}次下载`);
			}
			if (meta.updated) {
				parts.push(`上次更新 ${meta.updated}`);
			}
			row.metaEl.setText(parts.join(" · "));
		}
		// 热门/最近更新：元数据到位后原位重排（名称排序在渲染时已排好，无需再动）。
		const list = this._bodyEl;
		const stillSameQuery =
			(this._searchEl?.value ?? "").trim().toLowerCase() === query;
		if (this._searchSort === "name" || !list || !stillSameQuery) {
			return;
		}
		const elOf = new Map(rows.map((r) => [r.result, r.el] as const));
		for (const result of this._orderSearchResults(
			rows.map((r) => r.result),
			metas,
		)) {
			const el = elOf.get(result);
			if (el?.isConnected) {
				list.append(el);
			}
		}
	}

	async loadFor(pluginId: string, meta?: StoreDetailMeta): Promise<void> {
		this._ensureLayout();
		const root = this._bodyEl;
		if (!root) {
			return;
		}
		root.empty();
		this._versionSelect = null;
		const line = this._bannerLine();
		line.update("正在通过国内镜像获取信息…", "is-loading");

		try {
			// 清单复用主页已缓存的 listCache，不再每次详情页经镜像重下
			// 整份社区清单（2026-08-30 简化审计发现并修复）。
			await this._ensurePluginList();
			if (!this._listCache) {
				throw new Error("官方插件清单加载失败");
			}
			const { info, mirror } = await fetchPluginInfo(this._listCache, pluginId);
			const card = this._renderInfoCard(root, info, mirror, meta);
			line.close();
			const actions = root.createDiv({ cls: "op-actions" });
			this._renderVersion(actions, info);
			this._renderActions(actions, info);
			if (!meta) {
				void this._patchStoreMeta(card, info);
			}
		} catch (e) {
			line.update(`获取失败：${String(e)}`, "is-error");
		}
	}

	async loadTheme(themeName: string): Promise<void> {
		this._ensureLayout();
		const root = this._bodyEl;
		if (!root) {
			return;
		}
		root.empty();
		const line = this._bannerLine();
		line.update("正在通过国内镜像获取主题信息…", "is-loading");

		try {
			await this._ensureThemeList();
			const entry =
				this._themeListCache?.find((e) => e.name === themeName) ??
				this._themeListCache?.find(
					(e) => e.name.toLowerCase() === themeName.toLowerCase(),
				);
			if (!entry) {
				throw new Error("官方主题清单中无此主题");
			}
			this._renderThemeInfoCard(root, entry);
			line.close();
			const actions = root.createDiv({ cls: "op-actions" });
			this._renderThemeActions(actions, entry);
		} catch (e) {
			line.update(`获取失败：${String(e)}`, "is-error");
		}
	}

	private _renderInfoCard(
		container: HTMLElement,
		info: PluginInfo,
		mirror: { label: string; prefix: string },
		meta?: StoreDetailMeta,
	): { metaGroup: HTMLElement; idLine: HTMLElement } {
		const card = container.createDiv({ cls: "op-infocard" });
		this._addCloseButton(card);
		const titleGroup = card.createDiv({ cls: "op-group" });
		titleGroup.createEl("h3", { text: info.name, cls: "op-title" });
		const metaGroup = card.createDiv({ cls: "op-group" });
		if (info.installVersion) {
			const { value: valueEl } = this._addMetaLine(
				metaGroup,
				"版本",
				info.installVersion,
			);
			void this._annotateInstalledVersion(
				valueEl,
				info.installVersion,
				info.id,
			);
		}
		if (info.author) {
			this._addMetaLine(metaGroup, "作者", info.author);
		}
		if (meta?.downloads) {
			this._addMetaLine(metaGroup, "下载量", meta.downloads);
		}
		if (meta?.updated) {
			this._addMetaLine(metaGroup, "上次更新", meta.updated);
		}
		const idLine = this._addMetaLine(metaGroup, "ID", info.id).line;
		const compat = this._buildCompatLine(info);
		if (compat) {
			this._addMetaLine(metaGroup, "兼容", compat);
		}
		if (info.description) {
			const descGroup = card.createDiv({ cls: "op-group" });
			descGroup.createEl("p", { text: info.description, cls: "op-desc" });
			const preset = getPresetTranslation(info.id);
			if (preset) {
				descGroup.createEl("p", {
					cls: "op-desc-trans",
					text: `译文：${preset}`,
				});
			} else {
				const trans = descGroup.createEl("p", { cls: "op-desc-trans" });
				void this._translateDescription(info.description, trans);
			}
		}
		const linksGroup = card.createDiv({ cls: "op-group" });
		const links = linksGroup.createDiv({ cls: "op-links" });
		this._addSourceLink(
			links,
			"来源镜像：",
			mirror.label,
			`${mirror.prefix}https://github.com/${info.repo}/releases`,
		);
		this._addSourceLink(links, "源仓库：", info.repo, `https://github.com/${info.repo}`);
		return { metaGroup, idLine };
	}

	/**
	 * 顶部搜索进入详情时补官方元数据：按插件名查官方接口，命中本插件后把
	 * 「下载量 / 上次更新」插到 ID 行前（与商店路径详情同序）。失败或未命中
	 * 保持缺省；用户已切走时节点已脱离文档，写入无副作用。
	 */
	private async _patchStoreMeta(
		card: { metaGroup: HTMLElement; idLine: HTMLElement },
		info: PluginInfo,
	): Promise<void> {
		try {
			const metas = await fetchStoreMetaForQuery(info.name);
			const meta = metas.get(info.id);
			if (!meta || !card.metaGroup.isConnected) {
				return;
			}
			if (meta.downloads) {
				this._addMetaLine(
					card.metaGroup,
					"下载量",
					meta.downloads,
					card.idLine,
				);
			}
			if (meta.updated) {
				this._addMetaLine(
					card.metaGroup,
					"上次更新",
					meta.updated,
					card.idLine,
				);
			}
		} catch {
			// 商店接口不可用或补行失败：保持缺省，不阻塞详情
		}
	}

	private _renderThemeInfoCard(container: HTMLElement, theme: ThemeListItem): void {
		const card = container.createDiv({ cls: "op-infocard" });
		this._addCloseButton(card);
		const titleGroup = card.createDiv({ cls: "op-group" });
		titleGroup.createEl("h3", { text: theme.name, cls: "op-title" });
		const metaGroup = card.createDiv({ cls: "op-group" });
		this._addMetaLine(metaGroup, "作者", theme.author);
		this._addMetaLine(metaGroup, "类型", "主题");
		const linksGroup = card.createDiv({ cls: "op-group" });
		const links = linksGroup.createDiv({ cls: "op-links" });
		this._addSourceLink(links, "源仓库：", theme.repo, `https://github.com/${theme.repo}`);
	}

	/** 来源行：标签不加超链，仅冒号后的值可点（用户要求 2026-08-30）。 */
	private _addSourceLink(
		parent: HTMLElement,
		label: string,
		value: string,
		href: string,
	): void {
		const line = parent.createDiv({ cls: "op-source-line" });
		line.createSpan({ cls: "op-source-label", text: label });
		line.createEl("a", {
			cls: "op-source",
			text: value,
			href,
		}).setAttr("target", "_blank");
	}

	private _addCloseButton(parent: HTMLElement): void {
		const btn = parent.createEl("button", { cls: "op-close" });
		setIcon(btn, "x");
		btn.setAttribute("aria-label", "关闭并返回首页");
		btn.addEventListener("click", () => {
			this._searchComponent?.setValue("");
			this._storeSection?.setSearchActive(false);
			// 只清完结行：进行中的下载/更新行保留在顶部，任务与可见进度
			// 均不因返回首页中断
			this._bannerSweepFinished();
			if (this._bodyEl) {
				this._renderEmptyState(this._bodyEl);
			}
		});
	}

	/**
	 * 主页更新检测：枚举本库已安装插件 → 与官方清单求交（非官方插件无 repo
	 * 可查，跳过）→ 逐插件取 jsDelivr 最新稳定版（TTL 缓存，并发 4）→ 与
	 * 本地版本对比，列出有更新的官方插件；只读检测，更新由用户逐条发起。
	 */
	private async _checkAndRenderUpdates(section: HTMLElement): Promise<void> {
		const seq = ++this._updatesSeq;
		// 每轮重新探一次 data API；本轮所有插件共用结果，重试按钮可重新探测。
		// 探测失败后本会话的检查走镜像 manifest 降级（见 mirror.ts）。
		resetUpdateCheckSourceProbe();
		// 先落「检查中」状态行：官方清单加载可能较慢，避免板块空白
		// （2026-08-31 用户要求：无内容时区块不得只剩空壳）。
		this._updatesShell = null;
		section.empty();
		section.createDiv({
			cls: "op-updates-status",
			text: "正在检查插件更新…",
		});
		if (!this._listCache) {
			await this._ensurePluginList();
		}
		if (seq !== this._updatesSeq) {
			return;
		}
		if (!this._listCache) {
			this._renderUpdatesError(section, seq);
			return;
		}

		const [installed] = await Promise.all([
			this._enumerateInstalledPlugins(),
			this._preloadUpdateCache(),
		]);
		if (seq !== this._updatesSeq) {
			return;
		}

		const byId = new Map(this._listCache.map((e) => [e.id, e] as const));
		const candidates = installed.filter((i) => byId.has(i.id));
		const updates: PluginUpdateEntry[] = [];
		let failedCount = 0;
		const now = Date.now();
		const concurrency = 4;
		try {
			for (let from = 0; from < candidates.length; from += concurrency) {
				const batch = candidates.slice(from, from + concurrency);
				const settled = await Promise.allSettled(
					batch.map((i) => this._latestStableOf(i, byId, now)),
				);
				if (seq !== this._updatesSeq) {
					return;
				}
				for (const s of settled) {
					if (s.status === "fulfilled") {
						if (s.value) {
							updates.push(s.value);
						}
					} else {
						failedCount += 1;
					}
				}
			}
		} catch {
			this._renderUpdatesError(section, seq);
			return;
		}
		if (seq !== this._updatesSeq) {
			return;
		}
		this._renderUpdatesResult(section, updates, failedCount);
	}

	/** 单个已安装插件的最新稳定版（TTL 缓存命中则免请求）；不在清单返回 null。 */
	private async _latestStableOf(
		installed: InstalledPluginCheck,
		byId: Map<string, PluginListItem>,
		now: number,
	): Promise<PluginUpdateEntry | null> {
		const entry = byId.get(installed.id);
		if (!entry) {
			return null;
		}
		let latest: string | null = null;
		const cached = this._updateLatestCache.get(installed.id);
		if (cached && now - cached.at < OpenplugPickerView._UPDATE_CACHE_TTL_MS) {
			latest = cached.latest;
		} else {
			latest = await fetchUpdateTarget(entry.repo, installed.version);
			if (latest) {
				this._updateLatestCache.set(installed.id, { latest, at: now });
				this._updateCacheDirty = true;
				this._persistUpdateCache();
			}
		}
		// 数字更高才提示：≠ 会把本机更高（预发布装机/BRAT/上游 tag 时序）
		// 也推成更新，即推荐降级；解析失败视为无更新（宁漏不降级）。
		if (
			latest &&
			(compareNumericVersions(latest, installed.version) ?? 0) > 0
		) {
			return {
				id: installed.id,
				name: entry.name,
				author: entry.author,
				repo: entry.repo,
				installedVersion: installed.version,
				latestVersion: latest,
			};
		}
		return null;
	}

	/**
	 * 枚举本库已安装插件：插件目录里有 manifest 就算已安装（启用与否同理）。
	 *
	 * 逐个串行读 36 个 manifest 实测 11–62ms，且「更新」与「作者精选」会各
	 * 枚举一次；这里并发读（限 8 路，避免一次性打爆适配器）并按会话缓存，
	 * 两边共用同一份结果。安装/更新完成后调用 `_invalidateInstalledCache`
	 * 让下次重算（新装的插件要立刻从精选里消失）。
	 */
	private _installedCache: Promise<InstalledPluginCheck[]> | null = null;

	private _enumerateInstalledPlugins(): Promise<InstalledPluginCheck[]> {
		if (!this._installedCache) {
			this._installedCache = this._readInstalledPlugins().catch(() => []);
		}
		return this._installedCache;
	}

	private _invalidateInstalledCache(): void {
		this._installedCache = null;
	}

	private async _readInstalledPlugins(): Promise<InstalledPluginCheck[]> {
		const base = `${this.app.vault.configDir}/plugins`;
		const result: InstalledPluginCheck[] = [];
		let folders: string[] = [];
		try {
			folders = (await this.app.vault.adapter.list(base)).folders;
		} catch {
			// 插件目录不存在视为无已安装插件，不视为检查失败
			return result;
		}
		const pending = folders.slice();
		const worker = async (): Promise<void> => {
			for (;;) {
				const folder = pending.shift();
				if (folder === undefined) {
					return;
				}
				try {
					const name = folder.split("/").pop() ?? folder;
					const raw = await this.app.vault.adapter.read(
						`${base}/${name}/manifest.json`,
					);
					const manifest = JSON.parse(raw) as { id?: string; version?: string };
					if (manifest.id && manifest.version) {
						result.push({ id: manifest.id, version: manifest.version });
					}
				} catch {
					// 缺 manifest 的目录跳过（如已删除插件的残留）
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(8, pending.length) }, () => worker()),
		);
		return result;
	}

	/** 渲染检测结果：有更新 → 按页逐行（名称/作者/版本 + 更新按钮）；
	 * 无更新 → 「目前没有需要更新的插件。」；单项失败 → 失败统计行。
	 * 标题在壳外（renderEmptyState 创建，不在卡内）。 */
	private _renderUpdatesResult(
		section: HTMLElement,
		updates: PluginUpdateEntry[],
		failedCount: number,
	): void {
		// 自身（OpenPlug）有新版本时置顶，其余保持检测顺序：比较只看是否
		// 自身，sort 稳定，分页、逐条更新与重绘都沿用这一顺序。
		this._updatesData = updates
			.slice()
			.sort(
				(a, b) =>
					Number(a.id !== SELF_PLUGIN_ID) - Number(b.id !== SELF_PLUGIN_ID),
			);
		this._updatesFailed = failedCount;
		this._updatesPage = 1;
		section.empty();
		const list = section.createDiv();
		const pager = createPager(
			section,
			() => this._changeUpdatesPage(-1),
			() => this._changeUpdatesPage(1),
		);
		this._updatesShell = { section, list, pager };
		this._renderUpdatesPage();
	}

	/** 按当前页重绘行区。翻页条常驻、只改页码与按钮状态（键盘翻页不丢焦点）；
	 * 更新成功移除条目后也走这里——末页减空时页码自动回收到有内容的页。 */
	private _renderUpdatesPage(): void {
		const shell = this._updatesShell;
		if (!shell) {
			return;
		}
		const { list, pager } = shell;
		list.empty();
		if (this._updatesData.length === 0) {
			pager.hide();
			list.createDiv({
				cls: "op-updates-status",
				text:
					this._updatesFailed === 0
						? "目前没有需要更新的插件。"
						: `检查不完整：${this._updatesFailed} 个插件检查失败，已跳过。`,
			});
			return;
		}
		const pages = Math.max(
			1,
			Math.ceil(this._updatesData.length / UPDATES_PAGE_SIZE),
		);
		this._updatesPage = Math.min(this._updatesPage, pages);
		const from = (this._updatesPage - 1) * UPDATES_PAGE_SIZE;
		for (const u of this._updatesData.slice(from, from + UPDATES_PAGE_SIZE)) {
			this._renderUpdateRow(list, u);
		}
		if (this._updatesFailed > 0) {
			list.createDiv({
				cls: "op-updates-status",
				text: `${this._updatesFailed} 个插件检查失败，已跳过。`,
			});
		}
		pager.setPage(this._updatesPage, pages);
	}

	/** 单行：名称 / 作者 / 版本 + 行内更新按钮（复用详情页 meta 行）。 */
	private _renderUpdateRow(list: HTMLElement, u: PluginUpdateEntry): void {
		const row = list.createDiv({ cls: "op-update-row" });
		const info = row.createDiv({ cls: "op-update-info" });
		info.createDiv({ cls: "op-update-name", text: u.name });
		// 复用详情页 addMetaLine（版本：（已安装：）+ 作者），与详情卡同构
		// （样式行级覆盖见 .op-update-row .op-metaline）。
		if (u.author) {
			this._addMetaLine(info, "作者", u.author);
		}
		this._addMetaLine(
			info,
			"版本",
			`${u.latestVersion}（已安装：${u.installedVersion}）`,
		);
		const btn = row.createEl("button", {
			text: "更新",
			cls: "op-update-btn",
		});
		btn.setAttribute("aria-label", `更新 ${u.name} 到 ${u.latestVersion}`);
		btn.addEventListener("click", () => {
			void this._installUpdate(btn, u);
		});
	}

	/** 翻页：只切本地结果集，不重新检查；滚回板块顶部（与商店翻页一致）。 */
	private _changeUpdatesPage(delta: number): void {
		const pages = Math.max(
			1,
			Math.ceil(this._updatesData.length / UPDATES_PAGE_SIZE),
		);
		const next = Math.min(pages, Math.max(1, this._updatesPage + delta));
		if (next === this._updatesPage) {
			return;
		}
		this._updatesPage = next;
		this._updatesShell?.section.scrollIntoView({ block: "start" });
		this._renderUpdatesPage();
	}

	/** 整体检查失败态：提示 + 重试按钮。 */
	private _renderUpdatesError(section: HTMLElement, seq: number): void {
		if (seq !== this._updatesSeq) {
			return;
		}
		section.empty();
		section.createDiv({
			cls: "op-updates-status",
			text: "更新检查失败。",
		});
		const retry = section.createEl("button", {
			text: "重试",
			cls: "op-updates-retry",
		});
		retry.addEventListener("click", () => {
			void this._checkAndRenderUpdates(section);
		});
	}

	/**
	 * 行内更新：复用现役安装主链（fetchPluginInfo + installPlugin 指定版本，
	 * 镜像并发 + SHA256 交叉校验原样生效）。按用户决策（2026-08-30）更新
	 * 后仅提示「重启 Obsidian 后生效」，不自动重载插件；行成功后即时移除
	 * （TTL 内缓存的版本仍有效，下次打开按磁盘版本重新对比）。
	 */
	private async _installUpdate(
		btn: HTMLButtonElement,
		u: PluginUpdateEntry,
	): Promise<void> {
		await this._runPluginInstall(
			btn,
			u.id,
			u.name,
			u.latestVersion,
			`更新完成：${u.name} 已安装 ${u.latestVersion}，重启 Obsidian 后生效。`,
			() => {
				// 成功即从本轮结果集移除并按当前页重绘：分页后不能只 remove 一行
				// （会留下整页行 + 过期页码），末页减空时由重绘回收到有内容的页；
				// 全部更新完则落「目前没有需要更新的插件。」（2026-08-31 空态）。
				// 已离开主页/重开检测时壳体已被换成 null，重绘不写旧 DOM。
				this._updatesData = this._updatesData.filter((entry) => entry.id !== u.id);
				this._renderUpdatesPage();
			},
			"更新失败",
		);
	}

	/**
	 * 主页「作者精选」：常驻推荐位，只列尚未安装的条目（用户要求：已安装
	 * 再推荐即噪音）；全部已安装时标题与卡一起不出现，不留空壳。行结构 =
	 * 名称 + 一句介绍 + 安装按钮，样式复用「插件更新」（同一板块卡、行
	 * 节奏与右侧动作位）。已安装判定为本地读，完成后才落笔标题与卡。
	 */
	private async _renderAuthorPicks(host: HTMLElement): Promise<void> {
		const seq = ++this._picksSeq;
		const installed = new Set(
			(await this._enumerateInstalledPlugins()).map((i) => i.id),
		);		if (seq !== this._picksSeq) {
			return;
		}
		const picks = AUTHOR_PICKS.filter((p) => !installed.has(p.id));
		if (picks.length === 0) {
			return;
		}
		const heading = host.createDiv({ cls: "op-heading", text: "作者精选" });
		const section = host.createDiv({ cls: "op-updates" });
		for (const pick of picks) {
			const row = section.createDiv({ cls: "op-update-row" });
			const info = row.createDiv({ cls: "op-update-info" });
			info.createDiv({ cls: "op-update-name", text: pick.name });
			info.createDiv({ cls: "op-result-desc", text: pick.desc });
			const btn = row.createEl("button", {
				text: "安装",
				cls: "op-pick-btn",
			});
			btn.setAttribute("aria-label", `安装 ${pick.name}`);
			btn.addEventListener("click", () => {
				void this._installPick(btn, pick, heading, section);
			});
		}
	}

	/**
	 * 精选行内安装：复用现役安装主链（官方清单 → 镜像并发抓取 + SHA256
	 * 校验 → 写入并启用）。精选只列未安装条目，故主链按全新安装自动启用；
	 * 成功后该行即时移除（已是「已安装」，不再属于推荐），最后一个也算完
	 * 时标题与卡一起收掉。
	 */
	private async _installPick(
		btn: HTMLButtonElement,
		pick: AuthorPick,
		heading: HTMLElement,
		section: HTMLElement,
	): Promise<void> {
		await this._runPluginInstall(
			btn,
			pick.id,
			pick.name,
			undefined,
			`完成：${pick.name} 已安装并启用。`,
			() => {
				btn.parentElement?.remove();
				if (!section.querySelector(".op-update-row")) {
					heading.remove();
					section.remove();
				}
			},
		);
	}

	/**
	 * 插件安装统一入口（详情卡 / 更新行 / 作者精选共用）：同插件同版本并入
	 * 在途任务、异版本排队；清单加载、状态行推进、成功/失败文案与通道归还
	 * 都在这里单点维护（三处各写一份会漂移）。
	 */
	private async _runPluginInstall(
		btn: HTMLButtonElement,
		id: string,
		name: string,
		version: string | undefined,
		successText: string,
		onSuccess?: () => void,
		errorLabel = "安装失败",
	): Promise<void> {
		btn.disabled = true;
		const task = this._acquirePluginTask(id);
		const line = task.line;
		const progressText = (done: number): string =>
			`正在下载 ${name}（${done}/${INSTALL_TARGET_FILES}）…`;
		const hadActiveInstall = task.promise !== null;
		// 调用方已给出确切版本且同版本已在下载：直接并入，不再取信息
		// （避免一次重复镜像请求）。未给版本时仍先取信息再按主链判定。
		let result: { promise: Promise<void>; joined: boolean } | null =
			version !== undefined && task.promise && task.version === version
				? { promise: task.promise, joined: true }
				: null;
		let registered = false;
		if (!result && !hadActiveInstall) {
			line.update(progressText(0), "is-loading");
		}
		try {
			if (!result) {
				if (!this._listCache) {
					await this._ensurePluginList();
				}
				if (!this._listCache) {
					throw new Error("官方插件清单加载失败");
				}
				const { info } = await fetchPluginInfo(this._listCache, id);
				result = this._queuePluginInstall(
					task,
					info,
					version ?? info.installVersion,
					progressText,
				);
				registered = true;
			}
			await result.promise;
			if (!result.joined) {
				line.update(successText, "is-success");
			}
			// 安装/更新落盘后已装集合变了：让「作者精选」等下次重算
			this._invalidateInstalledCache();
			onSuccess?.();
		} catch (e) {
			// 并入在途任务时由原操作落错误态；仅当本轮真正发起/排了下载，
			// 或原本没有其它任务时才写共享行，避免盖掉在途进度。
			if (!result?.joined && (registered || !hadActiveInstall)) {
				line.update(`${errorLabel}：${String(e)}`, "is-error");
			}
			btn.disabled = false;
		} finally {
			this._releasePluginTask(id, task);
		}
	}

	private _addMetaLine(
		parent: HTMLElement,
		label: string,
		value: string,
		before?: HTMLElement,
	): { line: HTMLElement; value: HTMLElement } {
		const line = parent.createDiv({ cls: "op-metaline" });
		if (before) {
			parent.insertBefore(line, before);
		}
		line.createSpan({ cls: "op-metaline-label", text: label + "：" });
		return {
			line,
			value: line.createSpan({
				cls: "op-metaline-value",
				text: value,
			}),
		};
	}

	/**
	 * 已安装标注：本机插件目录存在该 id 的 manifest 即视为已安装（启用与否
	 * 都算，与官方社区浏览器的 Installed 语义一致），在「版本」行追加
	 * （已安装：x.y.z）；未安装或读取失败保持原样。异步落笔到既有值节点，
	 * 不阻塞详情卡首绘；用户已切走时节点已脱离文档，写入无副作用。
	 */
	private async _annotateInstalledVersion(
		valueEl: HTMLElement,
		version: string,
		pluginId: string,
	): Promise<void> {
		try {
			const raw = await this.app.vault.adapter.read(
				`${this.app.vault.configDir}/plugins/${pluginId}/manifest.json`,
			);
			const manifest = JSON.parse(raw) as { version?: string };
			if (manifest?.version) {
				valueEl.setText(`${version}（已安装：${manifest.version}）`);
			}
		} catch {
			// 未安装（读不到 manifest）或读取失败：保持仅显示最新版本
		}
	}

	private _buildCompatLine(info: PluginInfo): string | null {
		const parts: string[] = [];
		const minAppVersion = info.installMinAppVersion || info.minAppVersion;
		if (minAppVersion) {
			parts.push(`Obsidian ≥ ${minAppVersion}`);
		}
		parts.push(info.isDesktopOnly ? "仅支持电脑" : "兼容移动设备");
		return parts.length > 0 ? parts.join(" ；") : null;
	}

	private async _translateDescription(desc: string, el: HTMLElement): Promise<void> {
		const zh = await translateTextCached(desc);
		if (zh && zh.trim() && zh.trim() !== desc.trim()) {
			el.setText(`译文：${zh.trim()}`);
		} else {
			el.remove();
		}
	}

	/** 安装版本下拉：首项 = 本机可装版本（与卡片版本行同源）；其余只列
	 * 更旧的 tag，避免「最新」被更高但当前宿主装不了的版本夹在中间。 */
	private _renderVersion(parent: HTMLElement, info: PluginInfo): void {
		parent.createDiv({ cls: "op-field-label", text: "安装版本" });
		const select = parent.createEl("select", { cls: "op-select" });
		select.createEl("option", {
			value: "",
			text: `最新 ${info.installVersion}`,
		});
		this._versionSelect = select;
		void fetchPickerVersions(info.repo)
			.then((tags) => {
				for (const tag of tags) {
					if (tag === info.installVersion) {
						continue;
					}
					const newer =
						compareNumericVersions(tag, info.installVersion);
					if (newer !== null && newer > 0) {
						continue;
					}
					select.createEl("option", { value: tag, text: tag });
				}
			})
			.catch(() => {});
	}

	private _renderActions(parent: HTMLElement, info: PluginInfo): void {
		const btn = parent.createEl("button", {
			text: "下载安装并启用",
			cls: "mod-cta op-install-btn",
		});
		btn.addEventListener("click", () => {
			void this._doInstall(btn, info);
		});
	}

	private _renderThemeActions(parent: HTMLElement, theme: ThemeListItem): void {
		const btn = parent.createEl("button", {
			text: "下载安装并启用主题",
			cls: "mod-cta op-install-btn",
		});
		btn.addEventListener("click", () => {
			void this._doInstallTheme(btn, theme);
		});
	}

	private async _doInstall(
		btn: HTMLButtonElement,
		info: PluginInfo,
	): Promise<void> {
		const picked = this._versionSelect?.value || undefined;
		await this._runPluginInstall(
			btn,
			info.id,
			info.name,
			picked,
			picked
				? `完成，已安装 ${picked}。`
				: "完成，可在第三方插件列表中查看。",
		);
	}

	private async _doInstallTheme(
		btn: HTMLButtonElement,
		theme: ThemeListItem,
	): Promise<void> {
		btn.disabled = true;
		const line = this._bannerLine();
		let done = 0;
		const progress = (): void => {
			done += 1;
			line.update(
				`正在下载 ${theme.name} 主题（${done}/${INSTALL_THEME_BEATS}）…`,
				"is-loading",
			);
		};
		line.update(
			`正在下载 ${theme.name} 主题（0/${INSTALL_THEME_BEATS}）…`,
			"is-loading",
		);
		try {
			await installTheme(this.app, theme, progress);
			line.update(`完成，已启用主题：${theme.name}。`, "is-success");
		} catch (e) {
			line.update(`安装失败：${String(e)}`, "is-error");
			btn.disabled = false;
		}
	}
}
