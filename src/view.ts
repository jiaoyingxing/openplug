import { ItemView, Platform, setIcon } from "obsidian";

import { VIEW_TYPE_PICKER } from "./consts";
import { translateText } from "./translate";
import {
	fetchLatestStableVersion,
	fetchPluginInfo,
	fetchPluginList,
	fetchThemeList,
	fetchVersions,
	installPlugin,
	installTheme,
	INSTALL_TARGET_FILES,
	INSTALL_THEME_BEATS,
	InstalledPluginCheck,
	PluginInfo,
	PluginListItem,
	PluginUpdateEntry,
	ThemeListItem,
} from "./mirror";

type SearchKind = "plugin" | "theme";

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
	private bodyEl: HTMLElement | null = null;
	private rootEl: HTMLElement | null = null;
	private bannerEl: HTMLElement | null = null;
	private listCache: PluginListItem[] | null = null;
	private themeListCache: ThemeListItem[] | null = null;
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
		this.contentEl.empty();
		this.rootEl = null;
		this.searchEl = null;
		this.bodyEl = null;
	}

	private ensureLayout(): void {
		if (this.searchEl && this.bodyEl) {
			return;
		}
		this.contentEl.empty();
		this.rootEl = this.contentEl.createDiv({ cls: "openplug-root" });
		const topbar = this.rootEl.createDiv({ cls: "openplug-topbar" });
		const searchWrap = topbar.createDiv({ cls: "search-input-container" });
		this.searchEl = searchWrap.createEl("input", {
			cls: "openplug-search",
			type: "text",
			placeholder: "搜索插件名 / 主题名 / 作者…",
		});
		this.searchEl.addEventListener("input", () => {
			void this.onSearchInput();
		});
		this.bannerEl = topbar.createDiv({ cls: "openplug-banner is-hidden" });
		this.bodyEl = this.rootEl.createDiv({ cls: "openplug-body" });
	}

	private bannerLine(): BannerLine {
		const el = this.bannerEl;
		if (!el) {
			return { update: () => {}, close: () => {} };
		}
		// 新开操作：清掉已完结（成功/失败）的历史行，避免壳体堆积
		for (const child of Array.from(el.children)) {
			if (!child.classList.contains("is-loading")) {
				child.remove();
			}
		}
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

	/** 清空全部状态行（如关闭详情返回首页）。 */
	private bannerClear(): void {
		const el = this.bannerEl;
		if (!el) {
			return;
		}
		el.empty();
		this.recomputeBanner();
	}

	private renderEmptyState(container: HTMLElement): void {
		container.empty();
		const wrap = container.createDiv({ cls: "openplug-empty" });
		// 顶部「使用方式」：标题在壳外（设置页观感——大标题置于板块壳之上，
		// 2026-08-30 用户确认），卡内只放 3 步编号。
		wrap.createDiv({ cls: "openplug-heading", text: "使用方式" });
		const guideCard = wrap.createDiv({ cls: "openplug-home-card" });
		const ol = guideCard.createEl("ol", { cls: "openplug-steps" });
		// 5 句压缩为 3 句编号（2026-08-30 用户要求）：1+2 融合浏览/筛选，
		// 4 + 附注融合完成/搜索替代；官方社区链接、Add to Obsidian 语义
		// 与核心流程不减。第 3 句三连修（2026-08-30 用户复核）：同意弹窗
		// 在浏览器侧而非 Obsidian 内；安装需用户手动点按钮、非同意即装；
		// 删除后半句（搜索栏位于顶部、不言自明）。第一步仍内嵌官方社区
		// 链接；按位置判定，避免文案字符串与渲染逻辑耦合（改文案会静默
		// 丢链接）。
		const steps: string[] = [
			"打开 Obsidian 官方社区，筛选并找到你需要的插件或主题",
			'进入插件/主题页面，点击“Add to Obsidian”',
			"在浏览器中同意打开 Obsidian，回到本面板后点击安装按钮完成安装",
		];
		for (const [index, s] of steps.entries()) {
			const li = ol.createEl("li");
			if (index === 0) {
				// 按位置判定，避免文案字符串与渲染逻辑耦合（改文案会静默
				// 丢链接）。
				li.append("打开 ");
				const a = li.createEl("a", {
					text: "Obsidian 官方社区",
					href: "https://community.obsidian.md/",
				});
				a.addEventListener("click", (e) => {
					e.preventDefault();
					this.openExternal("https://community.obsidian.md/");
				});
				li.append("，筛选并找到你需要的插件或主题");
			} else {
				li.textContent = s;
			}
		}
		// 底部「插件更新」：标题在壳外（设置页观感），卡内只放检查状态与行。
		// 打开即自动检查（TTL 缓存兜底，决策见 DECISIONS「更新检测」）。
		wrap.createDiv({ cls: "openplug-heading", text: "插件更新" });
		const updatesEl = wrap.createDiv({ cls: "openplug-updates" });
		void this.checkAndRenderUpdates(updatesEl);
	}

	private openExternal(url: string): void {
		if (Platform.isMobile) {
			window.open(url, "_blank");
			return;
		}
		// 桌面：经 electron 直接打开系统浏览器，绕过 Obsidian 的 window-open
		// 拦截——启用「网页浏览器」核心插件（webviewer）时 window.open 会被
		// 转入应用内浏览器，内部浏览器无法触发 obsidian:// 深度链接回跳
		// （75555f8 的原设计意图；v1.1「统一 window.open」在无 webviewer 的
		// 环境误判该行为，见开发日志 20260828-2045 追加六/七）。
		// require 仅在此分支执行：移动端永不走到，无加载期 electron 依赖；
		// 不能用动态 import()（CJS 产物中无法解析，桌面实测无反应）。
		const { shell } = require("electron") as typeof import("electron");
		void shell.openExternal(url);
	}

	private async ensureLists(): Promise<void> {
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
	}

	private async onSearchInput(): Promise<void> {
		this.ensureLayout();
		const body = this.bodyEl;
		const q = (this.searchEl?.value ?? "").trim().toLowerCase();
		if (!body) {
			return;
		}
		if (!q) {
			body.empty();
			this.renderEmptyState(body);
			return;
		}
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
		for (const r of results.slice(0, 50)) {
			const row = body.createDiv({ cls: "openplug-result" });
			const titleRow = row.createDiv({ cls: "openplug-result-head" });
			titleRow.createDiv({ text: r.name, cls: "openplug-result-name" });
			titleRow.createDiv({
				text: r.kind === "theme" ? "主题" : "插件",
				cls: "openplug-result-tag",
			});
			row.createDiv({
				text: `${r.author} · ${r.desc}`,
				cls: "openplug-result-desc",
			});
			row.addEventListener("click", () => {
				if (r.kind === "plugin") {
					void this.loadFor(r.id);
				} else {
					void this.loadTheme(r.id);
				}
			});
		}
	}

	async loadFor(pluginId: string): Promise<void> {
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
			this.renderInfoCard(root, info, mirror);
			line.close();
			const actions = root.createDiv({ cls: "openplug-actions" });
			this.renderVersion(actions, info);
			this.renderActions(actions, info);
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
	): void {
		const card = container.createDiv({ cls: "openplug-infocard" });
		this.addCloseButton(card);
		const titleGroup = card.createDiv({ cls: "openplug-group" });
		titleGroup.createEl("h3", { text: info.name, cls: "openplug-title" });
		const metaGroup = card.createDiv({ cls: "openplug-group" });
		if (info.version) {
			const valueEl = this.addMetaLine(metaGroup, "版本", info.version);
			void this.annotateInstalledVersion(valueEl, info.version, info.id);
		}
		if (info.author) {
			this.addMetaLine(metaGroup, "作者", info.author);
		}
		this.addMetaLine(metaGroup, "ID", info.id);
		const compat = this.buildCompatLine(info);
		if (compat) {
			this.addMetaLine(metaGroup, "兼容", compat);
		}
		if (info.description) {
			const descGroup = card.createDiv({ cls: "openplug-group" });
			descGroup.createEl("p", { text: info.description, cls: "openplug-desc" });
			const trans = descGroup.createEl("p", { cls: "openplug-desc-trans" });
			void this.translateDescription(info.description, trans);
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
			if (this.searchEl) {
				this.searchEl.value = "";
			}
			this.bannerClear();
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

		section.empty();
		section.createDiv({
			cls: "openplug-updates-status",
			text: "正在检查插件更新…",
		});

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
		if (latest && latest !== installed.version) {
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

	/** 渲染检测结果：有更新 → 逐行（名称/作者/版本 + 更新按钮）；全最新或
	 * 单项失败 → 静默状态行。标题在壳外（renderEmptyState 创建，不在卡内）。 */
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
						? "已检查：所有官方插件均为最新。"
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
			btn.closest(".openplug-update-row")?.remove();
		} catch (e) {
			line.update(`更新失败：${String(e)}`, "is-error");
			btn.disabled = false;
		}
	}

	private addMetaLine(
		parent: HTMLElement,
		label: string,
		value: string,
	): HTMLElement {
		const line = parent.createDiv({ cls: "openplug-metaline" });
		line.createSpan({ cls: "openplug-metaline-label", text: label + "：" });
		return line.createSpan({ cls: "openplug-metaline-value", text: value });
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
		const zh = await translateText(desc);
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
		void fetchVersions(info.repo)
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
