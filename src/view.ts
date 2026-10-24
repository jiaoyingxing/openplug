import { ItemView, Notice, SearchComponent, setIcon } from "obsidian";

import { VIEW_TYPE_PICKER } from "./consts";
import { getPresetTranslation } from "./preset-translations";
import { fetchStoreMetaForQuery, StoreDetailMeta } from "./store";
import { StoreSection } from "./store-view";
import { translateTextCached } from "./translate";
import { openExternal } from "./util";
import {
	compareNumericVersions,
	fetchLatestStableVersion,
	fetchPluginInfo,
	fetchPluginList,
	fetchThemeList,
	fetchPickerVersions,
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

type BannerState = "is-loading" | "is-success" | "is-error";

/** 顶部状态行句柄：并发操作各占一行、互不覆盖；close() 移除该行。 */
interface BannerLine {
	update(text: string, state: BannerState): void;
	close(): void;
}

interface SearchResult {
	kind: SearchKind;
	id: string;
	name: string;
	author: string;
	desc: string;
}

export class OpenplugPickerView extends ItemView {
	private versionSelect: HTMLSelectElement | null = null;
	private searchEl: HTMLInputElement | null = null;
	private searchComponent: SearchComponent | null = null;
	private searchDebounceTimer: number | null = null;
	private bodyEl: HTMLElement | null = null;
	private rootEl: HTMLElement | null = null;
	private bannerEl: HTMLElement | null = null;
	private storeAddHost: HTMLElement | null = null;
	private storeSection: StoreSection | null = null;
	private listCache: PluginListItem[] | null = null;
	private themeListCache: ThemeListItem[] | null = null;
	/** 清单加载合一：并发调用共享同一轮请求，失败后下次重试。 */
	private listsPromise: Promise<void> | null = null;
	/** 更新检测的最新版本缓存（TTL 内不重复请求 jsDelivr；键 = 插件 id）。 */
	private updateLatestCache = new Map<string, { latest: string; at: number }>();
	private static readonly UPDATE_CACHE_TTL_MS = 60 * 60 * 1000;
	/** 主页重建竞态序号：搜索/关闭等动作重建主页后，旧检测结果不得写 DOM。 */
	private updatesSeq = 0;

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
		this.ensureLayout();
		if (this.bodyEl) {
			this.renderEmptyState(this.bodyEl);
		}
		void this.ensureLists();
	}

	async onClose(): Promise<void> {
		if (this.searchDebounceTimer !== null) {
			window.clearTimeout(this.searchDebounceTimer);
			this.searchDebounceTimer = null;
		}
		this.storeSection?.dispose();
		this.storeSection = null;
		this.contentEl.empty();
		this.rootEl = null;
		this.searchEl = null;
		this.searchComponent = null;
		this.storeAddHost = null;
		this.bodyEl = null;
	}

	private ensureLayout(): void {
		if (this.searchEl && this.bodyEl) {
			return;
		}
		this.contentEl.empty();
		this.rootEl = this.contentEl.createDiv({ cls: "openplug-root" });
		const topbar = this.rootEl.createDiv({ cls: "openplug-topbar" });
		const topRow = topbar.createDiv({ cls: "openplug-top-row" });
		const searchWrap = topRow.createDiv({ cls: "openplug-search-wrap" });
		const search = new SearchComponent(searchWrap);
		search.setPlaceholder("搜索插件名 / 主题名 / 作者…");
		search.inputEl.setAttribute("aria-label", "搜索插件名、主题名或作者");
		this.searchComponent = search;
		this.searchEl = search.inputEl;
		search.onChange(() => {
			if (this.searchDebounceTimer !== null) {
				window.clearTimeout(this.searchDebounceTimer);
			}
			this.searchDebounceTimer = window.setTimeout(() => {
				this.searchDebounceTimer = null;
				void this.onSearchInput();
			}, SEARCH_DEBOUNCE_MS);
		});
		this.storeAddHost = topRow.createDiv();
		this.bannerEl = topbar.createDiv({ cls: "openplug-banner is-hidden" });
		this.bodyEl = this.rootEl.createDiv({ cls: "openplug-body" });
	}

	private bannerLine(): BannerLine {
		const el = this.bannerEl;
		if (!el) {
			return { update: () => {}, close: () => {} };
		}
		// 新开操作：清掉已完结历史行（进行中的并发行原样保留）
		this.bannerSweepFinished();
		const line = el.createDiv({ cls: "openplug-banner-line is-loading" });
		el.classList.remove("is-hidden");
		let closed = false;
		this.recomputeBanner();
		return {
			update: (text, state) => {
				if (closed) {
					return;
				}
				line.setText(text);
				line.classList.toggle("is-loading", state === "is-loading");
				line.classList.toggle("is-success", state === "is-success");
				line.classList.toggle("is-error", state === "is-error");
				this.recomputeBanner();
			},
			close: () => {
				if (closed) {
					return;
				}
				closed = true;
				line.remove();
				this.recomputeBanner();
			},
		};
	}

	/** 依据现存状态行重算壳体：任意加载中 → is-loading（横移动效）；
	 * 无行 → 隐藏。 */
	private recomputeBanner(): void {
		const el = this.bannerEl;
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
	private bannerSweepFinished(): void {
		const el = this.bannerEl;
		if (!el) {
			return;
		}
		for (const child of Array.from(el.children)) {
			if (!child.classList.contains("is-loading")) {
				child.remove();
			}
		}
		this.recomputeBanner();
	}

	private renderEmptyState(container: HTMLElement): void {
		container.empty();
		const wrap = container.createDiv({ cls: "openplug-empty" });
		const store = this.ensureStoreSection();
		if (this.storeAddHost) {
			store.mountAddButton(this.storeAddHost);
		}
		const storeResultsEl = wrap.createDiv({
			cls: "openplug-store-section openplug-store-anchor",
		});
		store.mountResults(storeResultsEl);
		// 顶部「官方社区」：标题在壳外（设置页观感），卡内只放 3 步编号。
		wrap.createDiv({ cls: "openplug-heading", text: "官方社区" });
		const guideCard = wrap.createDiv({ cls: "openplug-home-card" });
		const ol = guideCard.createEl("ol", { cls: "openplug-steps" });
		// 5 句压缩为 3 句编号（2026-08-30 用户要求）：1+2 融合浏览/筛选，
		// 4 + 附注融合完成/搜索替代；官方社区链接、Add to Obsidian 语义
		// 与核心流程不减。第 3 句三连修（2026-08-30 用户复核）：同意弹窗
		// 在浏览器侧而非 Obsidian 内；安装需用户手动点按钮、非同意即装；
		// 删除后半句（搜索栏位于顶部、不言自明）。第一步单独构建以嵌入
		// 官方社区链接；后两步按顺序追加。
		const first = ol.createEl("li");
		first.append("打开 ");
		const communityLink = first.createEl("a", {
			text: "Obsidian 官方社区",
			href: "https://community.obsidian.md/",
		});
		communityLink.addEventListener("click", (e) => {
			e.preventDefault();
			openExternal("https://community.obsidian.md/");
		});
		first.append("，筛选并找到你需要的插件或主题");
		for (const s of [
			'进入插件/主题页面，点击“Add to Obsidian”',
			"在浏览器中同意打开 Obsidian，回到本面板后点击安装按钮完成安装",
		]) {
			ol.createEl("li", { text: s });
		}
		// 底部「插件更新」：标题在壳外（设置页观感），卡内只放检查状态与行。
		// 打开即自动检查（TTL 缓存兜底，决策见 DECISIONS「更新检测」）。
		wrap.createDiv({ cls: "openplug-heading", text: "插件更新" });
		const updatesEl = wrap.createDiv({ cls: "openplug-updates" });
		void this.checkAndRenderUpdates(updatesEl);
	}

	private ensureLists(): Promise<void> {
		if (this.listsPromise) {
			return this.listsPromise;
		}
		this.listsPromise = (async () => {
			if (!this.listCache) {
				try {
					this.listCache = await fetchPluginList();
				} catch {
					// 列表拉取失败不影响协议劫持路径
				}
			}
			if (!this.themeListCache) {
				try {
					this.themeListCache = await fetchThemeList();
				} catch {
					// 同上
				}
			}
		})().finally(() => {
			this.listsPromise = null;
		});
		return this.listsPromise;
	}

	private ensureStoreSection(): StoreSection {
		if (!this.storeSection) {
			this.storeSection = new StoreSection(
				this.app,
				(id, meta) => {
					void this.openPluginFromStore(id, meta);
				},
			);
		}
		return this.storeSection;
	}

	/** 商店行进入详情：先确保本地清单已就绪，再复用现役 loadFor 主链。 */
	private async openPluginFromStore(
		id: string,
		meta: StoreDetailMeta,
	): Promise<void> {
		if (!this.listCache) {
			const line = this.bannerLine();
			line.update("正在加载列表…", "is-loading");
			await this.ensureLists();
			line.close();
		} else {
			await this.ensureLists();
		}
		if (!this.listCache?.some((entry) => entry.id === id)) {
			new Notice("本地清单尚未同步，请稍后重试");
			return;
		}
		await this.loadFor(id, meta);
	}

	private async onSearchInput(): Promise<void> {
		this.ensureLayout();
		const body = this.bodyEl;
		const q = (this.searchEl?.value ?? "").trim().toLowerCase();
		if (!body) {
			return;
		}
		if (!q) {
			this.storeSection?.setSearchActive(false);
			body.empty();
			this.renderEmptyState(body);
			return;
		}
		this.storeSection?.setSearchActive(true);
		if (!this.listCache || !this.themeListCache) {
			body.empty();
			// 列表加载的临时文本并入顶部状态行（2026-08-30 用户要求
			// 「临时文本归拢统一」）。
			const line = this.bannerLine();
			line.update("正在加载列表…", "is-loading");
			await this.ensureLists();
			if (!this.listCache && !this.themeListCache) {
				body.empty();
				line.update("列表加载失败，请稍后重试。", "is-error");
				return;
			}
			line.close();
		}
		const results: SearchResult[] = [];
		if (this.listCache) {
			for (const e of this.listCache) {
				if (
					e.name.toLowerCase().includes(q) ||
					e.description.toLowerCase().includes(q) ||
					e.author.toLowerCase().includes(q) ||
					e.id.toLowerCase().includes(q)
				) {
					results.push({
						kind: "plugin",
						id: e.id,
						name: e.name,
						author: e.author,
						desc: e.description,
					});
				}
			}
		}
		if (this.themeListCache) {
			for (const e of this.themeListCache) {
				if (
					e.name.toLowerCase().includes(q) ||
					e.author.toLowerCase().includes(q) ||
					e.repo.toLowerCase().includes(q)
				) {
					results.push({
						kind: "theme",
						id: e.name,
						name: e.name,
						author: e.author,
						desc: e.repo,
					});
				}
			}
		}
		body.empty();
		if (results.length === 0) {
			body.createEl("p", { text: "未找到匹配的插件或主题。", cls: "openplug-muted" });
			return;
		}
		const metaRows: Array<{ id: string; el: HTMLElement; author: string }> = [];
		for (const r of results.slice(0, 50)) {
			const row = body.createDiv({ cls: "openplug-result" });
			const titleRow = row.createDiv({ cls: "openplug-result-head" });
			titleRow.createDiv({ text: r.name, cls: "openplug-result-name" });
			titleRow.createDiv({
				text: r.kind === "theme" ? "主题" : "插件",
				cls: "openplug-result-tag",
			});
			if (r.kind === "plugin") {
				// 与商店行同构：作者/下载量/上次更新一行，简介与译文各自成行；
				// 元数据异步回填，接口不可用时保持仅作者（与旧行为一致）。
				const metaLine = row.createDiv({
					text: r.author,
					cls: "openplug-result-desc",
				});
				metaRows.push({ id: r.id, el: metaLine, author: r.author });
				row.createDiv({ text: r.desc, cls: "openplug-result-desc" });
			} else {
				row.createDiv({
					text: `${r.author} · ${r.desc}`,
					cls: "openplug-result-desc",
				});
			}
			if (r.kind === "plugin") {
				const preset = getPresetTranslation(r.id);
				if (preset) {
					row.createDiv({
						cls: "openplug-result-trans openplug-desc-trans",
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
		if (metaRows.length > 0) {
			void this.enrichSearchMeta(q, metaRows);
		}
	}

	/** 顶部搜索行回填官方下载量/上次更新：一次查询批量按 slug 匹配；失败静默。 */
	private async enrichSearchMeta(
		query: string,
		rows: Array<{ id: string; el: HTMLElement; author: string }>,
	): Promise<void> {
		let metas: Map<string, StoreDetailMeta>;
		try {
			metas = await fetchStoreMetaForQuery(query);
		} catch {
			return;
		}
		for (const row of rows) {
			const meta = metas.get(row.id);
			if (!meta || !row.el.isConnected) {
				continue;
			}
			const parts = [row.author];
			if (meta.downloads) {
				parts.push(`${meta.downloads}次下载`);
			}
			if (meta.updated) {
				parts.push(`上次更新 ${meta.updated}`);
			}
			row.el.setText(parts.join(" · "));
		}
	}

	async loadFor(pluginId: string, meta?: StoreDetailMeta): Promise<void> {
		this.ensureLayout();
		const root = this.bodyEl;
		if (!root) {
			return;
		}
		root.empty();
		this.versionSelect = null;
		const line = this.bannerLine();
		line.update("正在通过国内镜像获取信息…", "is-loading");

		try {
			// 清单复用主页已缓存的 listCache，不再每次详情页经镜像重下
			// 整份社区清单（2026-08-30 简化审计发现并修复）。
			await this.ensureLists();
			if (!this.listCache) {
				throw new Error("官方插件清单加载失败");
			}
		const { info, mirror } = await fetchPluginInfo(this.listCache, pluginId);
		const card = this.renderInfoCard(root, info, mirror, meta);
		line.close();
		const actions = root.createDiv({ cls: "openplug-actions" });
		this.renderVersion(actions, info);
		this.renderActions(actions, info);
		if (!meta) {
			void this.patchStoreMeta(card, info);
		}
	} catch (e) {
		line.update(`获取失败：${String(e)}`, "is-error");
	}
}

	async loadTheme(themeName: string): Promise<void> {
		this.ensureLayout();
		const root = this.bodyEl;
		if (!root) {
			return;
		}
		root.empty();
		const line = this.bannerLine();
		line.update("正在通过国内镜像获取主题信息…", "is-loading");

		try {
			await this.ensureLists();
			const entry =
				this.themeListCache?.find((e) => e.name === themeName) ??
				this.themeListCache?.find(
					(e) => e.name.toLowerCase() === themeName.toLowerCase(),
				);
			if (!entry) {
				throw new Error("官方主题清单中无此主题");
			}
			this.renderThemeInfoCard(root, entry);
			line.close();
			const actions = root.createDiv({ cls: "openplug-actions" });
			this.renderThemeActions(actions, entry);
		} catch (e) {
			line.update(`获取失败：${String(e)}`, "is-error");
		}
	}

	private renderInfoCard(
		container: HTMLElement,
		info: PluginInfo,
		mirror: { label: string; prefix: string },
		meta?: StoreDetailMeta,
	): { metaGroup: HTMLElement; idLine: HTMLElement } {
		const card = container.createDiv({ cls: "openplug-infocard" });
		this.addCloseButton(card);
		const titleGroup = card.createDiv({ cls: "openplug-group" });
		titleGroup.createEl("h3", { text: info.name, cls: "openplug-title" });
		const metaGroup = card.createDiv({ cls: "openplug-group" });
		if (info.version) {
			const { value: valueEl } = this.addMetaLine(
				metaGroup,
				"版本",
				info.version,
			);
			void this.annotateInstalledVersion(valueEl, info.version, info.id);
		}
		if (info.author) {
			this.addMetaLine(metaGroup, "作者", info.author);
		}
		if (meta?.downloads) {
			this.addMetaLine(metaGroup, "下载量", meta.downloads);
		}
		if (meta?.updated) {
			this.addMetaLine(metaGroup, "上次更新", meta.updated);
		}
		const idLine = this.addMetaLine(metaGroup, "ID", info.id).line;
		const compat = this.buildCompatLine(info);
		if (compat) {
			this.addMetaLine(metaGroup, "兼容", compat);
		}
		if (info.description) {
			const descGroup = card.createDiv({ cls: "openplug-group" });
			descGroup.createEl("p", { text: info.description, cls: "openplug-desc" });
			const preset = getPresetTranslation(info.id);
			if (preset) {
				descGroup.createEl("p", {
					cls: "openplug-desc-trans",
					text: `译文：${preset}`,
				});
			} else {
				const trans = descGroup.createEl("p", { cls: "openplug-desc-trans" });
				void this.translateDescription(info.description, trans);
			}
		}
		const linksGroup = card.createDiv({ cls: "openplug-group" });
		const links = linksGroup.createDiv({ cls: "openplug-links" });
		this.addSourceLink(
			links,
			"来源镜像：",
			mirror.label,
			`${mirror.prefix}https://github.com/${info.repo}/releases`,
		);
		this.addSourceLink(links, "源仓库：", info.repo, `https://github.com/${info.repo}`);
		return { metaGroup, idLine };
	}

	/**
	 * 顶部搜索进入详情时补官方元数据：按插件名查官方接口，命中本插件后把
	 * 「下载量 / 上次更新」插到 ID 行前（与商店路径详情同序）。失败或未命中
	 * 保持缺省；用户已切走时节点已脱离文档，写入无副作用。
	 */
	private async patchStoreMeta(
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
				this.addMetaLine(
					card.metaGroup,
					"下载量",
					meta.downloads,
					card.idLine,
				);
			}
			if (meta.updated) {
				this.addMetaLine(
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

	private renderThemeInfoCard(container: HTMLElement, theme: ThemeListItem): void {
		const card = container.createDiv({ cls: "openplug-infocard" });
		this.addCloseButton(card);
		const titleGroup = card.createDiv({ cls: "openplug-group" });
		titleGroup.createEl("h3", { text: theme.name, cls: "openplug-title" });
		const metaGroup = card.createDiv({ cls: "openplug-group" });
		this.addMetaLine(metaGroup, "作者", theme.author);
		this.addMetaLine(metaGroup, "类型", "主题");
		const linksGroup = card.createDiv({ cls: "openplug-group" });
		const links = linksGroup.createDiv({ cls: "openplug-links" });
		this.addSourceLink(links, "源仓库：", theme.repo, `https://github.com/${theme.repo}`);
	}

	/** 来源行：标签不加超链，仅冒号后的值可点（用户要求 2026-08-30）。 */
	private addSourceLink(
		parent: HTMLElement,
		label: string,
		value: string,
		href: string,
	): void {
		const line = parent.createDiv({ cls: "openplug-source-line" });
		line.createSpan({ cls: "openplug-source-label", text: label });
		line.createEl("a", {
			cls: "openplug-source",
			text: value,
			href,
		}).setAttr("target", "_blank");
	}

	private addCloseButton(parent: HTMLElement): void {
		const btn = parent.createEl("button", { cls: "openplug-close" });
		setIcon(btn, "x");
		btn.setAttribute("aria-label", "关闭并返回首页");
		btn.addEventListener("click", () => {
			this.searchComponent?.setValue("");
			this.storeSection?.setSearchActive(false);
			// 只清完结行：进行中的下载/更新行保留在顶部，任务与可见进度
			// 均不因返回首页中断
			this.bannerSweepFinished();
			if (this.bodyEl) {
				this.renderEmptyState(this.bodyEl);
			}
		});
	}

	/**
	 * 主页更新检测：枚举本库已安装插件 → 与官方清单求交（非官方插件无 repo
	 * 可查，跳过）→ 逐插件取 jsDelivr 最新稳定版（TTL 缓存，并发 4）→ 与
	 * 本地版本对比，列出有更新的官方插件；只读检测，更新由用户逐条发起。
	 */
	private async checkAndRenderUpdates(section: HTMLElement): Promise<void> {
		const seq = ++this.updatesSeq;
		// 每轮重新探一次 data API；本轮所有插件共用结果，重试按钮可重新探测。
		// 探测失败后本会话的检查走镜像 manifest 降级（见 mirror.ts）。
		resetUpdateCheckSourceProbe();
		// 先落「检查中」状态行：官方清单加载可能较慢，避免板块空白
		// （2026-08-31 用户要求：无内容时区块不得只剩空壳）。
		section.empty();
		section.createDiv({
			cls: "openplug-updates-status",
			text: "正在检查插件更新…",
		});
		if (!this.listCache || !this.themeListCache) {
			await this.ensureLists();
		}
		if (seq !== this.updatesSeq) {
			return;
		}
		if (!this.listCache) {
			this.renderUpdatesError(section, seq);
			return;
		}

		const installed = await this.enumerateInstalledPlugins();
		if (seq !== this.updatesSeq) {
			return;
		}

		const byId = new Map(this.listCache.map((e) => [e.id, e] as const));
		const candidates = installed.filter((i) => byId.has(i.id));
		const updates: PluginUpdateEntry[] = [];
		let failedCount = 0;
		const now = Date.now();
		const concurrency = 4;
		try {
			for (let from = 0; from < candidates.length; from += concurrency) {
				const batch = candidates.slice(from, from + concurrency);
				const settled = await Promise.allSettled(
					batch.map((i) => this.latestStableOf(i, byId, now)),
				);
				if (seq !== this.updatesSeq) {
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
			this.renderUpdatesError(section, seq);
			return;
		}
		if (seq !== this.updatesSeq) {
			return;
		}
		this.renderUpdatesResult(section, updates, failedCount);
	}

	/** 单个已安装插件的最新稳定版（TTL 缓存命中则免请求）；不在清单返回 null。 */
	private async latestStableOf(
		installed: InstalledPluginCheck,
		byId: Map<string, PluginListItem>,
		now: number,
	): Promise<PluginUpdateEntry | null> {
		const entry = byId.get(installed.id);
		if (!entry) {
			return null;
		}
		let latest: string | null = null;
		const cached = this.updateLatestCache.get(installed.id);
		if (cached && now - cached.at < OpenplugPickerView.UPDATE_CACHE_TTL_MS) {
			latest = cached.latest;
		} else {
			latest = await fetchLatestStableVersion(entry.repo);
			if (latest) {
				this.updateLatestCache.set(installed.id, { latest, at: now });
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

	/** 枚举本库已安装插件：插件目录里有 manifest 就算已安装（启用与否同理）。 */
	private async enumerateInstalledPlugins(): Promise<InstalledPluginCheck[]> {
		const base = `${this.app.vault.configDir}/plugins`;
		const result: InstalledPluginCheck[] = [];
		try {
			const listed = await this.app.vault.adapter.list(base);
			for (const folder of listed.folders) {
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
		} catch {
			// 插件目录不存在视为无已安装插件，不视为检查失败
		}
		return result;
	}

	/** 渲染检测结果：有更新 → 逐行（名称/作者/版本 + 更新按钮）；
	 * 无更新 → 「目前没有需要更新的插件。」；单项失败 → 失败统计行。
	 * 标题在壳外（renderEmptyState 创建，不在卡内）。 */
	private renderUpdatesResult(
		section: HTMLElement,
		updates: PluginUpdateEntry[],
		failedCount: number,
	): void {
		section.empty();
		if (updates.length === 0) {
			section.createDiv({
				cls: "openplug-updates-status",
				text:
					failedCount === 0
						? "目前没有需要更新的插件。"
						: `检查不完整：${failedCount} 个插件检查失败，已跳过。`,
			});
			return;
		}
		for (const u of updates) {
			const row = section.createDiv({ cls: "openplug-update-row" });
			const info = row.createDiv({ cls: "openplug-update-info" });
			info.createDiv({ cls: "openplug-update-name", text: u.name });
			// 复用详情页 addMetaLine（版本：（已安装：）+ 作者），与详情卡同构
			// （样式行级覆盖见 .openplug-update-row .openplug-metaline）。
			if (u.author) {
				this.addMetaLine(info, "作者", u.author);
			}
			this.addMetaLine(
				info,
				"版本",
				`${u.latestVersion}（已安装：${u.installedVersion}）`,
			);
			const btn = row.createEl("button", {
				text: "更新",
				cls: "openplug-update-btn",
			});
			btn.setAttribute("aria-label", `更新 ${u.name} 到 ${u.latestVersion}`);
			btn.addEventListener("click", () => {
				void this.installUpdate(btn, u);
			});
		}
		if (failedCount > 0) {
			section.createDiv({
				cls: "openplug-updates-status",
				text: `${failedCount} 个插件检查失败，已跳过。`,
			});
		}
	}

	/** 整体检查失败态：提示 + 重试按钮。 */
	private renderUpdatesError(section: HTMLElement, seq: number): void {
		if (seq !== this.updatesSeq) {
			return;
		}
		section.empty();
		section.createDiv({
			cls: "openplug-updates-status",
			text: "更新检查失败。",
		});
		const retry = section.createEl("button", {
			text: "重试",
			cls: "openplug-updates-retry",
		});
		retry.addEventListener("click", () => {
			void this.checkAndRenderUpdates(section);
		});
	}

	/**
	 * 行内更新：复用现役安装主链（fetchPluginInfo + installPlugin 指定版本，
	 * 镜像并发 + SHA256 交叉校验原样生效）。按用户决策（2026-08-30）更新
	 * 后仅提示「重启 Obsidian 后生效」，不自动重载插件；行成功后即时移除
	 * （TTL 内缓存的版本仍有效，下次打开按磁盘版本重新对比）。
	 */
	private async installUpdate(
		btn: HTMLButtonElement,
		u: PluginUpdateEntry,
	): Promise<void> {
		btn.disabled = true;
		const line = this.bannerLine();
		line.update(`正在更新 ${u.name}…`, "is-loading");
		// 进度 = 文件数计数（常量见 mirror.INSTALL_TARGET_FILES；字节/百分比
		// 需流式读取会动摇主链，计数为最简单的诚实进度）。
		let done = 0;
		const progress = (): void => {
			done += 1;
			line.update(
				`正在下载 ${u.name}（${done}/${INSTALL_TARGET_FILES}）…`,
				"is-loading",
			);
		};
		line.update(`正在下载 ${u.name}（0/${INSTALL_TARGET_FILES}）…`, "is-loading");
		try {
			if (!this.listCache) {
				await this.ensureLists();
			}
			if (!this.listCache) {
				throw new Error("官方插件清单加载失败");
			}
			const { info } = await fetchPluginInfo(this.listCache, u.id);
			await installPlugin(this.app, info, progress, u.latestVersion);
			line.update(
				`更新完成：${u.name} 已安装 ${u.latestVersion}，重启 Obsidian 后生效。`,
				"is-success",
			);
			// 行成功即移除；若这是最后一行且板块内已无任何提示行，补「无
			// 更新」占位，避免板块只剩空壳（2026-08-31 用户要求）。
			// 注意：先取板块引用再移除行——remove() 后按钮已脱离文档，
			// closest() 会返回 null（2026-08-31 实测抓到的顺序 bug）。
			const updatesSection = btn.closest(".openplug-updates");
			btn.closest(".openplug-update-row")?.remove();
			if (
				updatesSection &&
				!updatesSection.querySelector(".openplug-update-row") &&
				!updatesSection.querySelector(".openplug-updates-status")
			) {
				updatesSection.createDiv({
					cls: "openplug-updates-status",
					text: "目前没有需要更新的插件。",
				});
			}
		} catch (e) {
			line.update(`更新失败：${String(e)}`, "is-error");
			btn.disabled = false;
		}
	}

	private addMetaLine(
		parent: HTMLElement,
		label: string,
		value: string,
		before?: HTMLElement,
	): { line: HTMLElement; value: HTMLElement } {
		const line = parent.createDiv({ cls: "openplug-metaline" });
		if (before) {
			parent.insertBefore(line, before);
		}
		line.createSpan({ cls: "openplug-metaline-label", text: label + "：" });
		return {
			line,
			value: line.createSpan({
				cls: "openplug-metaline-value",
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
	private async annotateInstalledVersion(
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

	private buildCompatLine(info: PluginInfo): string | null {
		const parts: string[] = [];
		if (info.minAppVersion) {
			parts.push(`Obsidian ≥ ${info.minAppVersion}`);
		}
		parts.push(info.isDesktopOnly ? "仅支持电脑" : "兼容移动设备");
		return parts.length > 0 ? parts.join(" ；") : null;
	}

	private async translateDescription(desc: string, el: HTMLElement): Promise<void> {
		const zh = await translateTextCached(desc);
		if (zh && zh.trim() && zh.trim() !== desc.trim()) {
			el.setText(`译文：${zh.trim()}`);
		} else {
			el.remove();
		}
	}

	private renderVersion(parent: HTMLElement, info: PluginInfo): void {
		parent.createDiv({ cls: "openplug-field-label", text: "安装版本" });
		const select = parent.createEl("select", { cls: "openplug-select" });
		select.createEl("option", { value: "", text: `最新 ${info.version}` });
		this.versionSelect = select;
		void fetchPickerVersions(info.repo)
			.then((tags) => {
				for (const tag of tags) {
					if (tag !== info.version) {
						select.createEl("option", { value: tag, text: tag });
					}
				}
			})
			.catch(() => {});
	}

	private renderActions(parent: HTMLElement, info: PluginInfo): void {
		const btn = parent.createEl("button", {
			text: "下载安装并启用",
			cls: "mod-cta openplug-install-btn",
		});
		btn.addEventListener("click", () => {
			void this.doInstall(btn, info);
		});
	}

	private renderThemeActions(parent: HTMLElement, theme: ThemeListItem): void {
		const btn = parent.createEl("button", {
			text: "下载安装并启用主题",
			cls: "mod-cta openplug-install-btn",
		});
		btn.addEventListener("click", () => {
			void this.doInstallTheme(btn, theme);
		});
	}

	private async doInstall(
		btn: HTMLButtonElement,
		info: PluginInfo,
	): Promise<void> {
		const version = this.versionSelect?.value || undefined;
		btn.disabled = true;
		const line = this.bannerLine();
		let done = 0;
		const progress = (): void => {
			done += 1;
			line.update(
				`正在下载 ${info.name}（${done}/${INSTALL_TARGET_FILES}）…`,
				"is-loading",
			);
		};
		line.update(`正在下载 ${info.name}（0/${INSTALL_TARGET_FILES}）…`, "is-loading");
		try {
			await installPlugin(this.app, info, progress, version);
			line.update(
				version
					? `完成，已安装 ${version}。`
					: "完成，可在第三方插件列表中查看。",
				"is-success",
			);
		} catch (e) {
			line.update(`安装失败：${String(e)}`, "is-error");
			btn.disabled = false;
		}
	}

	private async doInstallTheme(
		btn: HTMLButtonElement,
		theme: ThemeListItem,
	): Promise<void> {
		btn.disabled = true;
		const line = this.bannerLine();
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
