import {
	App,
	ExtraButtonComponent,
	FuzzyMatch,
	FuzzySuggestModal,
	setIcon,
} from "obsidian";

import { getPresetTranslation } from "./preset-translations";
import {
	buildDefaultCategoryOptions,
	CategoryOption,
	fetchStoreFacets,
	fetchStorePage,
	formatDownloads,
	formatUpdated,
	getCategoryMeta,
	STORE_ONLINE_ENABLED,
	STORE_PAGE_SIZE,
	StoreDetailMeta,
	StoreHitDocument,
	StorePage,
	StoreSort,
} from "./store";

/**
 * 分类筛选：添加按钮常驻顶部搜索行右侧；chips + 排序在下一行；
 * 结果卡只在已选分类且未搜索时出现在正文。
 */
export class StoreSection {
	private readonly app: App;
	private readonly openPlugin: (id: string, meta: StoreDetailMeta) => void;

	private readonly selectedTags = new Set<string>();
	private sort: StoreSort = "downloads";
	private page = 1;
	private pages = 1;
	private categoryOptions: CategoryOption[] = buildDefaultCategoryOptions();
	private categoriesLoaded = false;
	private categoriesLoading = false;
	private requestSeq = 0;
	private loading = false;
	private disposed = false;
	private searchActive = false;
	private lastResult: StorePage | null = null;
	private lastResultKey = "";
	private modal: CategoryModal | null = null;

	private addButtonRootEl: HTMLElement | null = null;
	private resultsRootEl: HTMLElement | null = null;
	private anchorEl: HTMLElement | null = null;
	private chipsEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private pagerEl: HTMLElement | null = null;
	private pageInfoEl: HTMLElement | null = null;
	private prevBtn: HTMLButtonElement | null = null;
	private nextBtn: HTMLButtonElement | null = null;

	constructor(
		app: App,
		openPlugin: (id: string, meta: StoreDetailMeta) => void,
	) {
		this.app = app;
		this.openPlugin = openPlugin;
	}

	mountAddButton(host: HTMLElement): void {
		if (this.disposed) {
			return;
		}
		if (this.addButtonRootEl !== host) {
			this.addButtonRootEl?.empty();
			this.addButtonRootEl?.removeClass("openplug-store-add-host");
			host.empty();
			host.addClass("openplug-store-add-host");
			this.addButtonRootEl = host;
			this.buildAddButton(host);
		}
	}

	mountResults(container: HTMLElement): void {
		if (this.disposed) {
			return;
		}
		this.anchorEl = container;
		if (!this.resultsRootEl) {
			container.empty();
			this.resultsRootEl = container.createDiv({ cls: "openplug-store" });
			this.buildResults(this.resultsRootEl);
		} else {
			container.empty();
			container.appendChild(this.resultsRootEl);
		}
		this.renderChips();
		this.updateVisibility();
		void this.loadCategories();
		if (this.selectedTags.size === 0 || this.searchActive) {
			return;
		}
		const key = this.currentKey();
		if (this.lastResult && this.lastResultKey === key) {
			this.renderResults(this.lastResult);
		} else if (!this.loading) {
			void this.refreshResults();
		}
	}

	setSearchActive(active: boolean): void {
		if (this.searchActive === active) {
			return;
		}
		this.searchActive = active;
		this.updateVisibility();
	}

	dispose(): void {
		this.disposed = true;
		this.requestSeq += 1;
		this.modal?.close();
		this.modal = null;
		this.addButtonRootEl?.empty();
		this.addButtonRootEl?.removeClass("openplug-store-add-host");
		this.addButtonRootEl = null;
		this.resultsRootEl?.remove();
		this.resultsRootEl = null;
	}

	isSelected(slug: string): boolean {
		return this.selectedTags.has(slug);
	}

	getCategoryOptions(): CategoryOption[] {
		return this.categoryOptions;
	}

	onModalClosed(modal: CategoryModal): void {
		if (this.modal === modal) {
			this.modal = null;
		}
	}

	clearCategories(): void {
		if (this.disposed || this.selectedTags.size === 0) {
			return;
		}
		this.selectedTags.clear();
		this.page = 1;
		this.renderChips();
		this.updateVisibility();
	}

	toggleCategory(slug: string): void {
		if (this.disposed) {
			return;
		}
		if (this.selectedTags.has(slug)) {
			this.selectedTags.delete(slug);
		} else {
			this.selectedTags.add(slug);
		}
		const active = this.selectedTags.size > 0;
		this.renderChips();
		this.page = 1;
		this.updateVisibility();
		if (active) {
			void this.refreshResults();
		}
	}

	private buildAddButton(host: HTMLElement): void {
		const add = host.createEl("button", { cls: "openplug-store-add" });
		const addIcon = add.createSpan({ cls: "openplug-store-add-icon" });
		setIcon(addIcon, "plus");
		add.createSpan({ text: "分类筛选" });
		add.addEventListener("click", () => this.openCategoryModal());
	}

	private buildResults(card: HTMLElement): void {
		const filterRow = card.createDiv({ cls: "openplug-store-toolbar" });
		this.chipsEl = filterRow.createDiv({
			cls: "openplug-store-chips is-hidden",
		});
		this.chipsEl.setAttribute("role", "list");
		const controls = filterRow.createDiv({ cls: "openplug-store-controls" });
		const sortEl = controls.createEl("select", { cls: "dropdown" });
		sortEl.setAttribute("aria-label", "排序");
		sortEl.createEl("option", { value: "downloads", text: "热门" });
		sortEl.createEl("option", { value: "updated", text: "最近更新" });
		sortEl.createEl("option", { value: "name", text: "名称" });
		sortEl.value = this.sort;
		sortEl.addEventListener("change", () => {
			this.sort = sortEl.value as StoreSort;
			this.page = 1;
			void this.refreshResults();
		});
		const clear = controls.createEl("button", {
			cls: "openplug-close openplug-store-clear",
		});
		setIcon(clear, "x");
		clear.setAttribute("aria-label", "清空筛选");
		clear.addEventListener("click", () => this.clearCategories());

		this.statusEl = card.createDiv({ cls: "openplug-store-status is-hidden" });
		this.listEl = card.createDiv({ cls: "openplug-store-list is-hidden" });

		const pager = card.createDiv({ cls: "openplug-store-pager is-hidden" });
		this.prevBtn = pager.createEl("button", {
			cls: "openplug-store-pager-btn",
			text: "上一页",
		});
		this.pageInfoEl = pager.createSpan({ cls: "openplug-store-pager-info" });
		this.nextBtn = pager.createEl("button", {
			cls: "openplug-store-pager-btn",
			text: "下一页",
		});
		this.prevBtn.addEventListener("click", () => this.changePage(-1));
		this.nextBtn.addEventListener("click", () => this.changePage(1));
		this.pagerEl = pager;
	}

	private openCategoryModal(): void {
		if (this.disposed || this.modal) {
			return;
		}
		void this.loadCategories();
		this.modal = new CategoryModal(this.app, this);
		this.modal.open();
	}

	private updateVisibility(): void {
		const active = this.selectedTags.size > 0;
		this.resultsRootEl?.toggleClass(
			"is-hidden",
			!active || this.searchActive,
		);
		if (active) {
			return;
		}
		this.requestSeq += 1;
		this.loading = false;
		this.statusEl?.addClass("is-hidden");
		this.statusEl?.empty();
		this.pagerEl?.addClass("is-hidden");
		this.listEl?.empty();
		this.lastResult = null;
		this.lastResultKey = "";
	}

	private async loadCategories(): Promise<void> {
		if (!STORE_ONLINE_ENABLED || this.categoriesLoaded || this.categoriesLoading) {
			return;
		}
		this.categoriesLoading = true;
		try {
			this.categoryOptions = await fetchStoreFacets();
			this.categoriesLoaded = true;
		} catch {
			// 保留默认 8 个官方分类；结果区仍按自己的错误态提示
		} finally {
			this.categoriesLoading = false;
		}
	}

	private currentKey(): string {
		return `${Array.from(this.selectedTags).sort().join(",")}|${this.sort}|${this.page}`;
	}

	private async refreshResults(): Promise<void> {
		if (this.disposed || this.selectedTags.size === 0) {
			return;
		}
		if (!STORE_ONLINE_ENABLED) {
			this.renderError("商店数据暂时不可用，请稍后重试。", false);
			return;
		}
		const seq = ++this.requestSeq;
		this.loading = true;
		this.setStatus("正在加载插件…");
		this.listEl?.empty();
		this.listEl?.addClass("is-hidden");
		this.pagerEl?.addClass("is-hidden");
		const key = this.currentKey();
		try {
			const result = await fetchStorePage(
				Array.from(this.selectedTags),
				this.sort,
				this.page,
			);
			if (this.disposed || seq !== this.requestSeq) {
				return;
			}
			this.lastResult = result;
			this.lastResultKey = key;
			this.loading = false;
			this.renderResults(result);
		} catch {
			if (this.disposed || seq !== this.requestSeq) {
				return;
			}
			this.loading = false;
			this.renderError("商店数据暂时不可用，请稍后重试。");
		}
	}

	private setStatus(text: string): void {
		const el = this.statusEl;
		if (!el) {
			return;
		}
		el.empty();
		el.removeClass("is-hidden");
		el.removeClass("is-error");
		el.createSpan({ text });
	}

	private renderError(message: string, retry = true): void {
		this.listEl?.empty();
		this.listEl?.addClass("is-hidden");
		this.pagerEl?.addClass("is-hidden");
		const el = this.statusEl;
		if (!el) {
			return;
		}
		el.empty();
		el.removeClass("is-hidden");
		el.addClass("is-error");
		el.createSpan({ text: message });
		if (retry && STORE_ONLINE_ENABLED) {
			const button = el.createEl("button", {
				cls: "openplug-store-retry",
				text: "重试",
			});
			button.addEventListener("click", () => {
				void this.loadCategories();
				void this.refreshResults();
			});
		}
	}

	private renderResults(result: StorePage): void {
		this.statusEl?.addClass("is-hidden");
		this.statusEl?.empty();
		const list = this.listEl;
		if (!list) {
			return;
		}
		list.empty();
		list.removeClass("is-hidden");
		const pages = Math.max(1, Math.ceil(result.found / STORE_PAGE_SIZE));
		if (this.page > pages) {
			this.page = pages;
			void this.refreshResults();
			return;
		}
		this.pages = pages;
		if (result.hits.length === 0) {
			list.createDiv({
				cls: "openplug-store-empty",
				text: "这个分类下暂时没有插件。",
			});
			this.pagerEl?.addClass("is-hidden");
			return;
		}
		for (const hit of result.hits) {
			const doc = hit.document;
			if (doc?.slug) {
				this.renderRow(list, doc);
			}
		}
		this.renderPager(pages);
	}

	private renderRow(list: HTMLElement, doc: StoreHitDocument): void {
		const slug = doc.slug;
		if (!slug) {
			return;
		}
		const row = list.createDiv({ cls: "openplug-result openplug-store-row" });
		row.setAttr("role", "button");
		row.setAttr("tabindex", "0");
		const head = row.createDiv({ cls: "openplug-result-head" });
		head.createDiv({ cls: "openplug-result-name", text: doc.name ?? slug });

		const parts: string[] = [];
		const author = doc.authors?.join(", ").trim() ?? "";
		if (author) {
			parts.push(author);
		}
		if (typeof doc.downloads === "number") {
			parts.push(`${formatDownloads(doc.downloads)}次下载`);
		}
		const updated = formatUpdated(doc.latest_release_at);
		if (updated) {
			parts.push(`上次更新 ${updated}`);
		}
		if (parts.length > 0) {
			row.createDiv({ cls: "openplug-result-desc", text: parts.join(" · ") });
		}
		if (doc.short_desc) {
			row.createDiv({
				cls: "openplug-result-desc openplug-store-desc",
				text: doc.short_desc,
			});
			const preset = getPresetTranslation(slug);
			if (preset) {
				row.createDiv({
					cls: "openplug-result-trans openplug-desc-trans",
					text: preset,
				});
			}
		}

		const open = (): void => {
			this.openPlugin(slug, {
				downloads:
					typeof doc.downloads === "number"
						? formatDownloads(doc.downloads)
						: "",
				updated,
			});
		};
		row.addEventListener("click", open);
		row.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				open();
			}
		});
	}

	private renderPager(pages: number): void {
		const pager = this.pagerEl;
		if (!pager || !this.pageInfoEl || !this.prevBtn || !this.nextBtn) {
			return;
		}
		if (pages <= 1) {
			pager.addClass("is-hidden");
			return;
		}
		pager.removeClass("is-hidden");
		this.pageInfoEl.setText(`第 ${this.page} / ${pages} 页`);
		this.prevBtn.disabled = this.page <= 1;
		this.nextBtn.disabled = this.page >= pages;
	}

	private changePage(delta: number): void {
		const next = Math.min(this.pages, Math.max(1, this.page + delta));
		if (next === this.page) {
			return;
		}
		this.page = next;
		this.anchorEl?.scrollIntoView({ block: "start" });
		void this.refreshResults();
	}

	private renderChips(): void {
		const el = this.chipsEl;
		if (!el) {
			return;
		}
		el.empty();
		if (this.selectedTags.size === 0) {
			el.addClass("is-hidden");
			return;
		}
		el.removeClass("is-hidden");
		for (const slug of this.selectedTags) {
			const meta = getCategoryMeta(slug);
			const chip = el.createDiv({
				cls: "openplug-store-chip",
				attr: { role: "listitem" },
			});
			chip.createSpan({
				cls: "openplug-store-chip-label",
				text: meta.label,
			});
			const remove = new ExtraButtonComponent(chip);
			remove.setIcon("x");
			remove.setTooltip(`移除 ${meta.label}`);
			remove.onClick(() => this.toggleCategory(slug));
			remove.extraSettingsEl.addClass("openplug-store-chip-remove");
			remove.extraSettingsEl.setAttribute(
				"aria-label",
				`移除 ${meta.label}`,
			);
		}
	}
}

/** 官方 FuzzySuggestModal：搜索、键盘、空态、关闭都由宿主接管。 */
class CategoryModal extends FuzzySuggestModal<CategoryOption> {
	private readonly store: StoreSection;

	constructor(app: App, store: StoreSection) {
		super(app);
		this.store = store;
		this.limit = 100;
		this.emptyStateText = "无匹配分类";
	}

	onOpen(): void {
		void super.onOpen();
		this.setTitle("添加分类");
		this.setPlaceholder("搜索分类…");
		this.setInstructions([
			{ command: "↑↓", purpose: "移动" },
			{ command: "↵", purpose: "添加" },
			{ command: "esc", purpose: "关闭" },
		]);
	}

	getItems(): CategoryOption[] {
		return this.store.getCategoryOptions();
	}

	getItemText(item: CategoryOption): string {
		return `${item.label} ${item.slug}`;
	}

	renderSuggestion(match: FuzzyMatch<CategoryOption>, el: HTMLElement): void {
		const option = match.item;
		el.addClass("openplug-store-suggest-item");
		el.empty();
		const icon = el.createSpan({ cls: "openplug-store-suggest-icon" });
		setIcon(icon, option.icon);
		if (!icon.querySelector("svg")) {
			icon.empty();
			setIcon(icon, "tag");
		}
		el.createSpan({ cls: "openplug-store-suggest-label", text: option.label });
		if (option.count !== null) {
			el.createSpan({
				cls: "openplug-store-suggest-count",
				text: option.count.toLocaleString("zh-CN"),
			});
		}
		const check = el.createSpan({ cls: "openplug-store-suggest-check" });
		if (this.store.isSelected(option.slug)) {
			setIcon(check, "check");
		}
	}

	onChooseItem(
		item: CategoryOption,
		_evt: MouseEvent | KeyboardEvent,
	): void {
		this.store.toggleCategory(item.slug);
	}

	onClose(): void {
		this.store.onModalClosed(this);
		super.onClose();
	}
}
