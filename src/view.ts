import { ItemView, Platform, setIcon } from "obsidian";

import { VIEW_TYPE_PICKER } from "./consts";
import { translateText } from "./translate";
import {
	fetchPluginInfo,
	fetchPluginList,
	fetchThemeList,
	fetchVersions,
	installPlugin,
	installTheme,
	PluginInfo,
	PluginListItem,
	ThemeListItem,
} from "./mirror";

type SearchKind = "plugin" | "theme";

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

	private bannerSet(
		text: string,
		state: "is-loading" | "is-success" | "is-error",
	): void {
		const el = this.bannerEl;
		if (!el) {
			return;
		}
		el.setText(text);
		el.classList.remove("is-hidden", "is-loading", "is-success", "is-error");
		el.classList.add(state);
	}

	private bannerHide(): void {
		const el = this.bannerEl;
		if (!el) {
			return;
		}
		el.classList.remove("is-loading", "is-success", "is-error");
		el.classList.add("is-hidden");
	}

	private renderEmptyState(container: HTMLElement): void {
		container.empty();
		const wrap = container.createDiv({ cls: "openplug-empty" });
		wrap.createEl("p", {
			cls: "openplug-empty-intro",
			text: "使用方式：",
		});
		const ol = wrap.createEl("ol", { cls: "openplug-steps" });
		const steps: string[] = [
			"打开 Obsidian 官方社区并浏览插件或主题",
			"筛选、找到你需要的插件或主题",
			'进入插件/主题页面，点击“Add to Obsidian”',
			"在 Obsidian 中同意跳转，自动回到本面板完成安装",
		];
		for (const s of steps) {
			const li = ol.createEl("li");
			if (s.startsWith("打开 Obsidian 官方社区")) {
				li.append("打开 ");
				const a = li.createEl("a", {
					text: "Obsidian 官方社区",
					href: "https://community.obsidian.md/",
				});
				a.addEventListener("click", (e) => {
					e.preventDefault();
					this.openExternal("https://community.obsidian.md/");
				});
				li.append(" 并浏览插件或主题");
			} else {
				li.textContent = s;
			}
		}
		wrap.createEl("p", {
			cls: "openplug-empty-note",
			text: "注：若你已有明确目标，可在本页顶部直接搜索安装。",
		});
	}

	private openExternal(url: string): void {
		if (Platform.isMobile) {
			window.open(url, "_blank");
			return;
		}
		// 仅桌面执行；移动端永不走到此分支，避免加载期依赖 electron 崩溃
		void import("electron").then((m) => m.shell.openExternal(url));
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
			body.createEl("p", { text: "正在加载列表…", cls: "openplug-muted" });
			await this.ensureLists();
			if (!this.listCache && !this.themeListCache) {
				body.empty();
				body.createEl("p", {
					text: "列表加载失败，请稍后重试。",
					cls: "openplug-muted",
				});
				return;
			}
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
		this.bannerSet("正在通过国内镜像获取信息…", "is-loading");

		try {
			const { info, mirror } = await fetchPluginInfo(pluginId);
			this.renderInfoCard(root, info, mirror);
			this.bannerHide();
			const actions = root.createDiv({ cls: "openplug-actions" });
			this.renderVersion(actions, info);
			this.renderActions(actions, info);
		} catch (e) {
			this.bannerSet(`获取失败：${String(e)}`, "is-error");
		}
	}

	async loadTheme(themeName: string): Promise<void> {
		this.ensureLayout();
		const root = this.bodyEl;
		if (!root) {
			return;
		}
		root.empty();
		this.bannerSet("正在通过国内镜像获取主题信息…", "is-loading");

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
			this.bannerHide();
			const actions = root.createDiv({ cls: "openplug-actions" });
			this.renderThemeActions(actions, entry);
		} catch (e) {
			this.bannerSet(`获取失败：${String(e)}`, "is-error");
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
			this.addMetaLine(metaGroup, "版本", info.version);
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
		links.createEl("a", {
			cls: "openplug-source",
			text: `来源镜像：${mirror.label}`,
			href: `${mirror.prefix}https://github.com/${info.repo}/releases`,
		}).setAttr("target", "_blank");
		links.createEl("a", {
			cls: "openplug-source",
			text: `源仓库：${info.repo}`,
			href: `https://github.com/${info.repo}`,
		}).setAttr("target", "_blank");
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
		links.createEl("a", {
			cls: "openplug-source",
			text: `源仓库：${theme.repo}`,
			href: `https://github.com/${theme.repo}`,
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
			this.bannerHide();
			if (this.bodyEl) {
				this.renderEmptyState(this.bodyEl);
			}
		});
	}

	private addMetaLine(parent: HTMLElement, label: string, value: string): void {		const line = parent.createDiv({ cls: "openplug-metaline" });
		line.createSpan({ cls: "openplug-metaline-label", text: label + "：" });
		line.createSpan({ cls: "openplug-metaline-value", text: value });
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
		this.bannerSet(version ? `开始下载 ${version}…` : "开始下载…", "is-loading");
		try {
			await installPlugin(
				this.app,
				info,
				(file) => this.bannerSet(`正在处理：${file}`, "is-loading"),
				version,
			);
			this.bannerSet(
				version
					? `完成，已安装 ${version}。`
					: "完成，可在第三方插件列表中查看。",
				"is-success",
			);
		} catch (e) {
			this.bannerSet(`安装失败：${String(e)}`, "is-error");
			btn.disabled = false;
		}
	}

	private async doInstallTheme(
		btn: HTMLButtonElement,
		theme: ThemeListItem,
	): Promise<void> {
		btn.disabled = true;
		this.bannerSet("开始下载主题…", "is-loading");
		try {
			await installTheme(this.app, theme, (file) =>
				this.bannerSet(`正在处理：${file}`, "is-loading"),
			);
			this.bannerSet(`完成，已启用主题：${theme.name}。`, "is-success");
		} catch (e) {
			this.bannerSet(`安装失败：${String(e)}`, "is-error");
			btn.disabled = false;
		}
	}
}
