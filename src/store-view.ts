import {
	App,
	ExtraButtonComponent,
	FuzzyMatch,
	FuzzySuggestModal,
	setIcon,
} from "obsidian";

import { createPager, PagerHandle } from "./pager";
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

/** 商店数据不可用的统一错误文案（开关关闭与请求失败共用一处）。 */
const STORE_UNAVAILABLE_MESSAGE = "商店数据暂时不可用，请稍后重试。";

/**
 * 分类筛选：添加按钮常驻顶部搜索行右侧；chips + 排序在下一行；
 * 结果卡只在已选分类且未搜索时出现在正文。
 */
export class StoreSection {
	private readonly _app: App;
	private readonly _openPlugin: (id: string, meta: StoreDetailMeta) => void;

	private readonly _selectedTags = new Set<string>();
	private _sort: StoreSort = "downloads";
	private _page = 1;
	private _pages = 1;
	private _categoryOptions: CategoryOption[] = buildDefaultCategoryOptions();
	private _categoriesLoaded = false;
	private _categoriesLoading = false;
	private _requestSeq = 0;
	private _loading = false;
	private _disposed = false;
	private _searchActive = false;
	private _lastResult: StorePage | null = null;
	private _lastResultKey = "";
	private _modal: CategoryModal | null = null;

	private _addButtonRootEl: HTMLElement | null = null;
	private _resultsRootEl: HTMLElement | null = null;
	private _anchorEl: HTMLElement | null = null;
	private _chipsEl: HTMLElement | null = null;
	private _statusEl: HTMLElement | null = null;
	private _listEl: HTMLElement | null = null;
	private _pager: PagerHandle | null = null;

	constructor(
		app: App,
		openPlugin: (id: string, meta: StoreDetailMeta) => void,
	) {
		this._app = app;
		this._openPlugin = openPlugin;
	}

	mountAddButton(host: HTMLElement): void {
		if (this._disposed) {
			return;
		}
		if (this._addButtonRootEl !== host) {
			this._addButtonRootEl?.empty();
			this._addButtonRootEl?.removeClass("op-store-add-host");
			host.empty();
			host.addClass("op-store-add-host");
			this._addButtonRootEl = host;
			this._buildAddButton(host);
		}
	}

	mountResults(container: HTMLElement): void {
		if (this._disposed) {
			return;
		}
		this._anchorEl = container;
		if (!this._resultsRootEl) {
			container.empty();
			this._resultsRootEl = container.createDiv({ cls: "op-store" });
			this._buildResults(this._resultsRootEl);
		} else {
			container.empty();
			container.appendChild(this._resultsRootEl);
		}
		this._renderChips();
		this._updateVisibility();
		void this._loadCategories();
		if (this._selectedTags.size === 0 || this._searchActive) {
			return;
		}
		const key = this._currentKey();
		if (this._lastResult && this._lastResultKey === key) {
			this._renderResults(this._lastResult);
		} else if (!this._loading) {
			void this._refreshResults();
		}
	}

	setSearchActive(active: boolean): void {
		if (this._searchActive === active) {
			return;
		}
		this._searchActive = active;
		this._updateVisibility();
	}

	dispose(): void {
		this._disposed = true;
		this._requestSeq += 1;
		this._modal?.close();
		this._modal = null;
		this._addButtonRootEl?.empty();
		this._addButtonRootEl?.removeClass("op-store-add-host");
		this._addButtonRootEl = null;
		this._resultsRootEl?.remove();
		this._resultsRootEl = null;
	}

	isSelected(slug: string): boolean {
		return this._selectedTags.has(slug);
	}

	getCategoryOptions(): CategoryOption[] {
		return this._categoryOptions;
	}

	onModalClosed(modal: CategoryModal): void {
		if (this._modal === modal) {
			this._modal = null;
		}
	}

	clearCategories(): void {
		if (this._disposed || this._selectedTags.size === 0) {
			return;
		}
		this._selectedTags.clear();
		this._page = 1;
		this._renderChips();
		this._updateVisibility();
	}

	toggleCategory(slug: string): void {
		if (this._disposed) {
			return;
		}
		if (this._selectedTags.has(slug)) {
			this._selectedTags.delete(slug);
		} else {
			this._selectedTags.add(slug);
		}
		const active = this._selectedTags.size > 0;
		this._renderChips();
		this._page = 1;
		this._updateVisibility();
		if (active) {
			void this._refreshResults();
		}
	}

	private _buildAddButton(host: HTMLElement): void {
		const add = host.createEl("button", { cls: "op-store-add" });
		const addIcon = add.createSpan({ cls: "op-store-add-icon" });
		setIcon(addIcon, "plus");
		add.createSpan({ text: "分类筛选" });
		add.addEventListener("click", () => this._openCategoryModal());
	}

	private _buildResults(card: HTMLElement): void {
		const filterRow = card.createDiv({ cls: "op-store-toolbar" });
		this._chipsEl = filterRow.createDiv({
			cls: "op-store-chips is-hidden",
		});
		this._chipsEl.setAttribute("role", "list");
		const controls = filterRow.createDiv({ cls: "op-store-controls" });
		const sortEl = controls.createEl("select", { cls: "dropdown" });
		sortEl.setAttribute("aria-label", "排序");
		sortEl.createEl("option", { value: "downloads", text: "热门" });
		sortEl.createEl("option", { value: "updated", text: "最近更新" });
		sortEl.createEl("option", { value: "name", text: "名称" });
		sortEl.value = this._sort;
		sortEl.addEventListener("change", () => {
			this._sort = sortEl.value as StoreSort;
			this._page = 1;
			void this._refreshResults();
		});
		const clear = controls.createEl("button", {
			cls: "op-close op-store-clear",
		});
		setIcon(clear, "x");
		clear.setAttribute("aria-label", "清空筛选");
		clear.addEventListener("click", () => this.clearCategories());

		this._statusEl = card.createDiv({ cls: "op-store-status is-hidden" });
		this._listEl = card.createDiv({ cls: "op-store-list is-hidden" });

		this._pager = createPager(
			card,
			() => this._changePage(-1),
			() => this._changePage(1),
		);
	}

	private _openCategoryModal(): void {
		if (this._disposed || this._modal) {
			return;
		}
		void this._loadCategories();
		this._modal = new CategoryModal(this._app, this);
		this._modal.open();
	}

	private _updateVisibility(): void {
		const active = this._selectedTags.size > 0;
		this._resultsRootEl?.toggleClass(
			"is-hidden",
			!active || this._searchActive,
		);
		if (active) {
			return;
		}
		this._requestSeq += 1;
		this._loading = false;
		this._statusEl?.addClass("is-hidden");
		this._statusEl?.empty();
		this._pager?.hide();
		this._listEl?.empty();
		this._lastResult = null;
		this._lastResultKey = "";
	}

	private async _loadCategories(): Promise<void> {
		if (!STORE_ONLINE_ENABLED || this._categoriesLoaded || this._categoriesLoading) {
			return;
		}
		this._categoriesLoading = true;
		try {
			this._categoryOptions = await fetchStoreFacets();
			this._categoriesLoaded = true;
		} catch {
			// 保留默认 8 个官方分类；结果区仍按自己的错误态提示
		} finally {
			this._categoriesLoading = false;
		}
	}

	private _currentKey(): string {
		return `${Array.from(this._selectedTags).sort().join(",")}|${this._sort}|${this._page}`;
	}

	private async _refreshResults(): Promise<void> {
		if (this._disposed || this._selectedTags.size === 0) {
			return;
		}
		if (!STORE_ONLINE_ENABLED) {
			this._renderError(STORE_UNAVAILABLE_MESSAGE, false);
			return;
		}
		const seq = ++this._requestSeq;
		this._loading = true;
		this._setStatus("正在加载插件…");
		this._listEl?.empty();
		this._listEl?.addClass("is-hidden");
		this._pager?.hide();
		const key = this._currentKey();
		try {
			const result = await fetchStorePage(
				Array.from(this._selectedTags),
				this._sort,
				this._page,
			);
			if (this._disposed || seq !== this._requestSeq) {
				return;
			}
			this._lastResult = result;
			this._lastResultKey = key;
			this._loading = false;
			this._renderResults(result);
		} catch {
			if (this._disposed || seq !== this._requestSeq) {
				return;
			}
			this._loading = false;
			this._renderError(STORE_UNAVAILABLE_MESSAGE);
		}
	}

	private _setStatus(text: string): void {
		const el = this._statusEl;
		if (!el) {
			return;
		}
		el.empty();
		el.removeClass("is-hidden");
		el.removeClass("is-error");
		el.createSpan({ text });
	}

	private _renderError(message: string, retry = true): void {
		this._listEl?.empty();
		this._listEl?.addClass("is-hidden");
		this._pager?.hide();
		const el = this._statusEl;
		if (!el) {
			return;
		}
		el.empty();
		el.removeClass("is-hidden");
		el.addClass("is-error");
		el.createSpan({ text: message });
		if (retry && STORE_ONLINE_ENABLED) {
			const button = el.createEl("button", {
				cls: "op-store-retry",
				text: "重试",
			});
			button.addEventListener("click", () => {
				void this._loadCategories();
				void this._refreshResults();
			});
		}
	}

	private _renderResults(result: StorePage): void {
		this._statusEl?.addClass("is-hidden");
		this._statusEl?.empty();
		const list = this._listEl;
		if (!list) {
			return;
		}
		list.empty();
		list.removeClass("is-hidden");
		const pages = Math.max(1, Math.ceil(result.found / STORE_PAGE_SIZE));
		if (this._page > pages) {
			this._page = pages;
			void this._refreshResults();
			return;
		}
		this._pages = pages;
		if (result.hits.length === 0) {
			list.createDiv({
				cls: "op-store-empty",
				text: "这个分类下暂时没有插件。",
			});
			this._pager?.hide();
			return;
		}
		for (const hit of result.hits) {
			const doc = hit.document;
			if (doc?.slug) {
				this._renderRow(list, doc);
			}
		}
		this._pager?.setPage(this._page, pages);
	}

	private _renderRow(list: HTMLElement, doc: StoreHitDocument): void {
		const slug = doc.slug;
		if (!slug) {
			return;
		}
		const row = list.createDiv({ cls: "op-result op-store-row" });
		row.setAttr("role", "button");
		row.setAttr("tabindex", "0");
		const head = row.createDiv({ cls: "op-result-head" });
		head.createDiv({ cls: "op-result-name", text: doc.name ?? slug });

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
			row.createDiv({ cls: "op-result-desc", text: parts.join(" · ") });
		}
		if (doc.short_desc) {
			row.createDiv({
				cls: "op-result-desc op-store-desc",
				text: doc.short_desc,
			});
			const preset = getPresetTranslation(slug);
			if (preset) {
				row.createDiv({
					cls: "op-result-trans op-desc-trans",
					text: preset,
				});
			}
		}

		const open = (): void => {
			this._openPlugin(slug, {
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

	private _changePage(delta: number): void {
		const next = Math.min(this._pages, Math.max(1, this._page + delta));
		if (next === this._page) {
			return;
		}
		this._page = next;
		this._anchorEl?.scrollIntoView({ block: "start" });
		void this._refreshResults();
	}

	private _renderChips(): void {
		const el = this._chipsEl;
		if (!el) {
			return;
		}
		el.empty();
		if (this._selectedTags.size === 0) {
			el.addClass("is-hidden");
			return;
		}
		el.removeClass("is-hidden");
		for (const slug of this._selectedTags) {
			const meta = getCategoryMeta(slug);
			const chip = el.createDiv({
				cls: "op-store-chip",
				attr: { role: "listitem" },
			});
			chip.createSpan({
				cls: "op-store-chip-label",
				text: meta.label,
			});
			const remove = new ExtraButtonComponent(chip);
			remove.setIcon("x");
			remove.setTooltip(`移除 ${meta.label}`);
			remove.onClick(() => this.toggleCategory(slug));
			remove.extraSettingsEl.addClass("op-store-chip-remove");
			remove.extraSettingsEl.setAttribute(
				"aria-label",
				`移除 ${meta.label}`,
			);
		}
	}
}

/** 官方 FuzzySuggestModal：搜索、键盘、空态、关闭都由宿主接管。 */
class CategoryModal extends FuzzySuggestModal<CategoryOption> {
	private readonly _store: StoreSection;

	constructor(app: App, store: StoreSection) {
		super(app);
		this._store = store;
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
		return this._store.getCategoryOptions();
	}

	getItemText(item: CategoryOption): string {
		return `${item.label} ${item.slug}`;
	}

	renderSuggestion(match: FuzzyMatch<CategoryOption>, el: HTMLElement): void {
		const option = match.item;
		el.addClass("op-store-suggest-item");
		el.empty();
		const icon = el.createSpan({ cls: "op-store-suggest-icon" });
		setIcon(icon, option.icon);
		if (!icon.querySelector("svg")) {
			icon.empty();
			setIcon(icon, "tag");
		}
		el.createSpan({ cls: "op-store-suggest-label", text: option.label });
		if (option.count !== null) {
			el.createSpan({
				cls: "op-store-suggest-count",
				text: option.count.toLocaleString("zh-CN"),
			});
		}
		const check = el.createSpan({ cls: "op-store-suggest-check" });
		if (this._store.isSelected(option.slug)) {
			setIcon(check, "check");
		}
	}

	onChooseItem(
		item: CategoryOption,
		_evt: MouseEvent | KeyboardEvent,
	): void {
		this._store.toggleCategory(item.slug);
	}

	onClose(): void {
		this._store.onModalClosed(this);
		super.onClose();
	}
}
