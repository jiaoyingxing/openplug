import {
	App,
	ItemView,
	Menu,
	Notice,
	SearchComponent,
	WorkspaceLeaf,
	requestUrl,
	sanitizeHTMLToDom,
	setIcon,
	setTooltip,
} from "obsidian";

import {
	FORUM_BASE,
	FORUM_TIMEOUT_MS,
	FORUM_USER_AGENT,
	VIEW_TYPE_FORUM,
} from "./consts";
import {
	clearForumAuth,
	ForumAuthModal,
	loadForumAuth,
} from "./forum-auth";
import type { ForumAuthSession } from "./forum-auth";
import { openExternal, withTimeout } from "./util";

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * 打开（或复用）内置论坛视图：已有 leaf 就激活，内容未就绪才重设视图状态。
 * 主页入口与核心命令共用一份（两处各写一份会漂移，2026-11-20）。
 */
export async function openForumView(app: App): Promise<void> {
	const workspace = app.workspace;
	const leaves = workspace.getLeavesOfType(VIEW_TYPE_FORUM);
	const leaf = leaves.length > 0 ? leaves[0] : workspace.getLeaf(true);
	if (!leaf) {
		return;
	}
	const view = leaf.view as unknown as { contentEl?: HTMLElement };
	const alive =
		leaves.length > 0 &&
		!!view.contentEl?.querySelector(".op-forum-root");
	if (!alive) {
		await leaf.setViewState({ type: VIEW_TYPE_FORUM, active: true });
	}
	await workspace.revealLeaf(leaf);
	workspace.setActiveLeaf(leaf, { focus: true });
}


type SortMode = "latest" | "top";

interface ForumCategory {
	id: number;
	name: string;
	topic_count?: number;
}

interface ForumTopic {
	id: number;
	title: string;
	posts_count: number;
	views?: number;
	category_id?: number;
	last_posted_at?: string;
}

interface ForumActionSummary {
	id: number;
	count?: number;
	acted?: boolean;
}

interface ForumPost {
	id: number;
	username: string;
	created_at: string;
	cooked: string;
	post_number?: number;
	actions_summary?: ForumActionSummary[];
}

interface ForumTopicDetail {
	id: number;
	title: string;
	posts_count: number;
	views?: number;
	category_id?: number;
	last_posted_at?: string;
	post_stream?: {
		posts?: ForumPost[];
		stream?: number[];
	};
}

interface CategoriesPayload {
	category_list?: {
		categories?: ForumCategory[];
	};
}

interface TopicListPayload {
	topic_list?: {
		topics?: ForumTopic[];
	};
	topics?: ForumTopic[];
}

interface AboutPayload {
	about?: {
		stats?: {
			topics_count?: number;
		};
	};
}

/** 论坛视图：公开 JSON 拉取分类/列表/详情，帖子正文经宿主
 * sanitizeHTMLToDom 清洗；登录可选，设备授权后点赞/取消赞、就地回复；
 * 未登录保持只读。 */
export class ForumView extends ItemView {
	private _rootEl: HTMLElement | null = null;
	private _bodyEl: HTMLElement | null = null;
	private _postsEl: HTMLElement | null = null;
	private _footerEl: HTMLElement | null = null;
	private _sentinelEl: HTMLElement | null = null;
	private _backBtn: HTMLButtonElement | null = null;
	private _authBtn: HTMLButtonElement | null = null;
	private _authSession: ForumAuthSession | null = null;
	private _localReplyEl: HTMLElement | null = null;
	private _searchComponent: SearchComponent | null = null;
	private _searchTimer: number | null = null;
	private _categories: ForumCategory[] = [];
	private _categoryNames = new Map<number, string>();
	private _categoryTotals = new Map<number, number>();
	private _aboutTotal: number | null = null;
	private _selectedCategoryId: number | null = null;
	private _sort: SortMode = "latest";
	private _query = "";
	private _page = 1;
	private _totalPages = 0;
	private _listScrollTop = 0;
	private _restoreScrollTop: number | null = null;
	private _currentTopicId: number | null = null;
	private _currentTopic: ForumTopicDetail | null = null;
	private _currentTopicPage = 0;
	private _topicStreamLength = 0;
	private _loadedPostIds = new Set<number>();
	private _loadingMore = false;
	private _postsDrained = false;
	private _observer: IntersectionObserver | null = null;
	private _requestSeq = 0;
	private _disposed = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_FORUM;
	}

	getDisplayText(): string {
		return "中文论坛";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		this._disposed = false;
		this.contentEl.classList.add("op-forum-view");
		this.contentEl.empty();
		this._authSession = loadForumAuth(this.app);
		this._rootEl = this.contentEl.createDiv({ cls: "op-forum-root" });
		this._buildTopbar();
		this._bodyEl = this._rootEl.createDiv();
		this.contentEl.addEventListener("click", this._onContentClick);
		void this._init();
	}

	async onClose(): Promise<void> {
		this._disposed = true;
		this._clearSearchTimer();
		this._disconnectObserver();
		this.contentEl.removeEventListener("click", this._onContentClick);
		this.contentEl.empty();
		this.contentEl.classList.remove("op-forum-view");
		this._rootEl = null;
		this._bodyEl = null;
		this._postsEl = null;
		this._footerEl = null;
		this._sentinelEl = null;
		this._backBtn = null;
		this._authBtn = null;
		this._authSession = null;
		this._localReplyEl = null;
		this._searchComponent = null;
		this._searchTimer = null;
		this._currentTopic = null;
		this._currentTopicId = null;
	}

	private _buildTopbar(): void {
		const root = this._rootEl;
		if (!root) {
			return;
		}
		const bar = root.createDiv({ cls: "op-forum-topbar" });
		this._backBtn = this._createIconButton(bar, "chevron-left", "返回", () => {
			this._goBack();
		});
		this._backBtn.disabled = true;
		bar.createDiv({ cls: "op-forum-spacer" });
		this._authBtn = bar.createEl("button", {
			cls: "op-forum-auth-entry",
			attr: { type: "button" },
		});
		this._authBtn.addEventListener("click", (event) => {
			this._onAuthEntry(event);
		});
		this._updateAuthEntry();
		this._createIconButton(bar, "globe", "在浏览器打开", () => {
			this._openCurrentInBrowser();
		});
		this._createIconButton(bar, "refresh-cw", "刷新", () => {
			void this._refreshCurrent();
		});
		this._createIconButton(bar, "x", "关闭", () => {
			this.leaf.detach();
		});
	}

	private _createIconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const btn = parent.createEl("button", {
			cls: "clickable-icon op-forum-icon-btn",
			attr: { "aria-label": label },
		});
		setIcon(btn, icon);
		setTooltip(btn, label);
		btn.addEventListener("click", onClick);
		return btn;
	}

	private _updateAuthEntry(): void {
		const btn = this._authBtn;
		if (!btn) {
			return;
		}
		const session = this._authSession;
		btn.toggleClass("is-login", !session);
		btn.toggleClass("is-account", !!session);
		if (session) {
			const display = session.name || session.username;
			const initial = Array.from(display.trim())[0] ?? "论";
			btn.setText(initial.toUpperCase());
			btn.setAttr("aria-label", `论坛账号：${display}`);
			setTooltip(btn, display);
			return;
		}
		btn.setText("登录");
		btn.setAttr("aria-label", "登录中文论坛");
		setTooltip(btn, "登录中文论坛");
	}

	private _onAuthEntry(event: MouseEvent): void {
		const session = this._authSession;
		if (!session) {
			this._openAuth();
			return;
		}
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(session.name || session.username)
				.setIcon("user")
				.setDisabled(true),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("撤销授权")
				.setIcon("log-out")
				.onClick(() => {
					void this._revokeAuth();
				}),
		);
		menu.showAtMouseEvent(event);
	}

	private _openAuth(): void {
		new ForumAuthModal(this.app, (session) => {
			this._authSession = session;
			this._updateAuthEntry();
			new Notice(
				`已登录为 ${session.name || session.username}`,
			);
		}).open();
	}

	private async _revokeAuth(): Promise<void> {
		const session = this._authSession;
		if (!session) {
			return;
		}
		try {
			await withTimeout(
				requestUrl({
					url: `${FORUM_BASE}/user-api-key/revoke`,
					method: "POST",
					headers: this._headers(session),
					throw: false,
				}),
				FORUM_TIMEOUT_MS,
			);
		} catch {
			// 网络失败也清本地：钥匙可在论坛「应用」页另行撤销。
		}
		try {
			clearForumAuth(this.app);
		} catch {
			// SecretStorage 清理失败时仍切回未登录界面。
		}
		this._authSession = null;
		this._updateAuthEntry();
		new Notice("已撤销论坛授权");
	}

	/** 授权与写接口共用的请求头（Accept + 插件 UA；有会话时附设备授权两键）。
	 *  匿名读路 _api 不带头（公开 JSON 无需 UA，与拍板「授权/写入带 UA」口径一致）。 */
	private _headers(session: ForumAuthSession | null): Record<string, string> {
		return {
			Accept: "application/json",
			"User-Agent": FORUM_USER_AGENT,
			...(session
				? {
						"User-Api-Key": session.key,
						"User-Api-Client-Id": session.clientId,
					}
				: {}),
		};
	}

	private _setBackEnabled(enabled: boolean): void {
		if (this._backBtn) {
			this._backBtn.disabled = !enabled;
		}
	}

	private async _init(): Promise<void> {
		await this._loadCategories();
		await this._loadAboutTotal();
		if (this._disposed) {
			return;
		}
		await this._loadList();
	}

	private async _loadCategories(): Promise<void> {
		try {
			const data = await this._api<CategoriesPayload>("/categories.json");
			const categories = data.category_list?.categories ?? [];
			this._categories = categories.filter(
				(category) => typeof category.id === "number" && !!category.name,
			);
			for (const category of this._categories) {
				this._categoryNames.set(category.id, category.name);
				if (typeof category.topic_count === "number") {
					this._categoryTotals.set(category.id, category.topic_count);
				}
			}
		} catch {
			// 分类失败不阻塞列表：只保留「全部」。
		}
	}

	private async _loadAboutTotal(): Promise<void> {
		try {
			const data = await this._api<AboutPayload>("/about.json");
			const total = data.about?.stats?.topics_count;
			if (typeof total === "number" && total > 0) {
				this._aboutTotal = total;
			}
		} catch {
			// 总页数未知时列表仍可翻页，只是不显示总页数。
		}
	}

	private async _loadList(): Promise<void> {
		this._clearSearchTimer();
		const seq = ++this._requestSeq;
		this._disconnectObserver();
		this._currentTopicId = null;
		this._currentTopic = null;
		this._localReplyEl = null;
		this._setBackEnabled(false);
		this._renderStatus("正在加载论坛…");
		try {
			const topics = await this._fetchTopics();
			if (seq !== this._requestSeq || this._disposed) {
				return;
			}
			this._renderList(topics);
		} catch {
			if (seq !== this._requestSeq || this._disposed) {
				return;
			}
			this._renderError("论坛暂时不可用，请稍后重试。", () => {
				void this._loadList();
			});
		}
	}

	private async _fetchTopics(): Promise<ForumTopic[]> {
		const pageParam = Math.max(0, this._page - 1);
		if (this._query) {
			const data = await this._api<TopicListPayload>(
				`/search.json?q=${encodeURIComponent(this._query)}`,
			);
			this._totalPages = 0;
			return data.topics ?? [];
		}
		if (this._selectedCategoryId !== null) {
			const id = this._selectedCategoryId;
			const path =
				this._sort === "top"
					? `/top.json?period=weekly&category=${id}&page=${pageParam}`
					: `/c/${id}.json?page=${pageParam}`;
			const data = await this._api<TopicListPayload>(path);
			const total = this._categoryTotals.get(id);
			this._totalPages =
				this._sort === "latest" && total
					? Math.max(1, Math.ceil(total / PAGE_SIZE))
					: 0;
			return data.topic_list?.topics ?? [];
		}
		const path =
			this._sort === "top"
				? `/top.json?period=weekly&page=${pageParam}`
				: `/latest.json?page=${pageParam}`;
		const data = await this._api<TopicListPayload>(path);
		this._totalPages =
			this._sort === "latest" && this._aboutTotal
				? Math.max(1, Math.ceil(this._aboutTotal / PAGE_SIZE))
				: 0;
		return data.topic_list?.topics ?? [];
	}

	private _renderList(topics: ForumTopic[]): void {
		const body = this._bodyEl;
		if (!body) {
			return;
		}
		body.empty();
		this._setBackEnabled(false);

		const searchRow = body.createDiv({ cls: "op-forum-search-row" });
		const searchWrap = searchRow.createDiv({
			cls: "op-forum-search-wrap",
		});
		const search = new SearchComponent(searchWrap);
		search.setPlaceholder("搜索帖子…");
		search.setValue(this._query);
		search.onChange(() => {
			this._onSearchInput();
		});
		this._searchComponent = search;

		const sort = searchRow.createEl("select", {
			cls: "dropdown op-forum-sort",
			attr: { "aria-label": "排序" },
		});
		for (const [value, label] of [
			["latest", "最新"],
			["top", "热门"],
		] as const) {
			sort.createEl("option", { value, text: label });
		}
		sort.value = this._sort;
		sort.addEventListener("change", () => {
			this._sort = sort.value === "top" ? "top" : "latest";
			this._page = 1;
			void this._loadList();
		});

		const chips = body.createDiv({ cls: "op-forum-chips" });
		this._createChip(chips, null, "全部");
		for (const category of this._categories) {
			this._createChip(chips, category.id, category.name);
		}

		if (topics.length === 0) {
			body.createDiv({
				cls: "op-forum-status",
				text: this._query
					? "没有找到相关帖子。"
					: "这个分类下暂时没有帖子。",
			});
		} else {
			const list = body.createDiv({ cls: "op-forum-list" });
			for (const topic of topics) {
				this._renderTopicRow(list, topic);
			}
		}

		const hasPrev = this._page > 1;
		const hasNext =
			this._totalPages > 0
				? this._page < this._totalPages
				: topics.length >= PAGE_SIZE;
		if (!this._query && (hasPrev || hasNext || this._totalPages > 1)) {
			const pager = body.createDiv({ cls: "op-forum-pager" });
			const prev = pager.createEl("button", {
				text: "上一页",
				cls: "op-forum-pager-btn",
			});
			prev.disabled = !hasPrev;
			prev.addEventListener("click", () => {
				if (this._page > 1) {
					this._page -= 1;
					void this._loadList();
				}
			});
			pager.createSpan({
				text:
					this._totalPages > 0
						? `第 ${this._page} / ${this._totalPages} 页`
						: `第 ${this._page} 页`,
			});
			const next = pager.createEl("button", {
				text: "下一页",
				cls: "op-forum-pager-btn",
			});
			next.disabled = !hasNext;
			next.addEventListener("click", () => {
				if (hasNext) {
					this._page += 1;
					void this._loadList();
				}
			});
		}

		const footer = body.createDiv({ cls: "op-forum-footer" });
		footer.createSpan({
			text: "内容来自 Obsidian 中文论坛",
		});
		const link = footer.createEl("a", {
			cls: "op-forum-link",
			text: "在浏览器打开",
			href: this._currentBrowseUrl(),
		});
		link.addEventListener("click", (event) => {
			event.preventDefault();
			openExternal(this._currentBrowseUrl());
		});

		if (this._restoreScrollTop !== null) {
			const restore = this._restoreScrollTop;
			this._restoreScrollTop = null;
			window.requestAnimationFrame(() => {
				this.contentEl.scrollTop = restore;
			});
		}
	}

	private _createChip(
		parent: HTMLElement,
		categoryId: number | null,
		label: string,
	): void {
		const chip = parent.createEl("button", {
			cls: "op-forum-chip",
			text: label,
		});
		chip.toggleClass("is-active", this._selectedCategoryId === categoryId);
		chip.addEventListener("click", () => {
			if (this._selectedCategoryId === categoryId) {
				return;
			}
			this._selectedCategoryId = categoryId;
			this._page = 1;
			if (this._query) {
				this._query = "";
				this._searchComponent?.setValue("");
			}
			void this._loadList();
		});
	}

	private _renderTopicRow(parent: HTMLElement, topic: ForumTopic): void {
		const row = parent.createDiv({ cls: "op-forum-topic" });
		row.setAttr("role", "button");
		row.setAttr("tabindex", "0");
		row.createDiv({
			cls: "op-forum-topic-title",
			text: topic.title,
		});
		const meta = row.createDiv({ cls: "op-forum-topic-meta" });
		if (topic.category_id) {
			meta.createSpan({
				cls: "op-forum-topic-cat",
				text: this._categoryName(topic.category_id),
			});
		}
		if (topic.last_posted_at) {
			meta.createSpan({
				text: this._relativeTime(topic.last_posted_at),
			});
		}
		if (typeof topic.views === "number") {
			meta.createSpan({
				cls: "op-forum-topic-views",
				text: `${topic.views} 浏览`,
			});
		}
		row.createSpan({
			cls: "op-forum-topic-replies",
			text: `${topic.posts_count} 回复`,
		});
		const open = (): void => {
			void this._openTopicById(topic.id);
		};
		row.addEventListener("click", open);
		row.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				open();
			}
		});
	}

	private _onSearchInput(): void {
		this._clearSearchTimer();
		this._searchTimer = window.setTimeout(() => {
			this._searchTimer = null;
			this._query = this._searchComponent?.inputEl.value.trim() ?? "";
			if (this._query) {
				this._selectedCategoryId = null;
			}
			this._page = 1;
			void this._loadList();
		}, SEARCH_DEBOUNCE_MS);
	}

	private async _openTopicById(topicId: number): Promise<void> {
		const seq = ++this._requestSeq;
		this._disconnectObserver();
		this._listScrollTop = this.contentEl.scrollTop;
		this._currentTopicId = topicId;
		this._currentTopic = null;
		this._currentTopicPage = 0;
		this._loadedPostIds.clear();
		this._localReplyEl = null;
		this._topicStreamLength = 0;
		this._postsDrained = false;
		this._setBackEnabled(true);
		this._renderStatus("正在加载帖子…");
		try {
			const detail = await this._fetchTopic(topicId, 0);
			if (seq !== this._requestSeq || this._disposed) {
				return;
			}
			this._currentTopic = detail;
			this._topicStreamLength = Math.max(
				detail.post_stream?.stream?.length ?? 0,
				detail.posts_count,
			);
			this._renderTopic(detail);
			this.contentEl.scrollTop = 0;
		} catch {
			if (seq !== this._requestSeq || this._disposed) {
				return;
			}
			this._renderError("帖子暂时无法加载。", () => {
				void this._openTopicById(topicId);
			});
		}
	}

	private async _fetchTopic(
		topicId: number,
		page: number,
	): Promise<ForumTopicDetail> {
		return this._api<ForumTopicDetail>(
			`/t/${topicId}.json?page=${page}`,
		);
	}

	private _renderTopic(detail: ForumTopicDetail): void {
		const body = this._bodyEl;
		if (!body) {
			return;
		}
		body.empty();
		this._setBackEnabled(true);
		this._localReplyEl = null;
		const panel = body.createDiv({ cls: "op-forum-detail" });
		const head = panel.createDiv({ cls: "op-forum-topic-head" });
		head.createEl("h2", {
			cls: "op-forum-topic-head-title",
			text: detail.title,
		});
		const meta = head.createDiv({ cls: "op-forum-topic-head-meta" });
		if (detail.category_id) {
			meta.createSpan({
				cls: "op-forum-topic-cat",
				text: this._categoryName(detail.category_id),
			});
		}
		meta.createSpan({ text: `${detail.posts_count} 回复` });
		if (typeof detail.views === "number") {
			meta.createSpan({
				cls: "op-forum-topic-views",
				text: `${detail.views} 浏览`,
			});
		}
		if (detail.last_posted_at) {
			meta.createSpan({
				text: `最后回复 ${this._relativeTime(detail.last_posted_at)}`,
			});
		}
		this._postsEl = panel.createDiv();
		this._appendPosts(detail.post_stream?.posts ?? []);
		if (this._loadedPostIds.size >= this._topicStreamLength) {
			this._postsDrained = true;
		}
		this._sentinelEl = panel.createDiv({ cls: "op-forum-sentinel" });
		this._footerEl = panel.createDiv({ cls: "op-forum-footer" });
		this._footerEl.createSpan({
			text: "内容来自 Obsidian 中文论坛",
		});
		const link = this._footerEl.createEl("a", {
			cls: "op-forum-link",
			text: "查看原帖",
			href: `${FORUM_BASE}/t/${detail.id}`,
		});
		link.addEventListener("click", (event) => {
			event.preventDefault();
			openExternal(`${FORUM_BASE}/t/${detail.id}`);
		});
		this._startObserving();
	}

	private _appendPosts(
		posts: ForumPost[],
		before: HTMLElement | null = null,
	): HTMLElement[] {
		const host = this._postsEl;
		if (!host) {
			return [];
		}
		const created: HTMLElement[] = [];
		for (const post of posts) {
			if (this._loadedPostIds.has(post.id) || !post.cooked) {
				continue;
			}
			this._loadedPostIds.add(post.id);
			const item = this._createPostEl(post);
			if (before) {
				host.insertBefore(item, before);
			}
			created.push(item);
		}
		return created;
	}

	private _createPostEl(post: ForumPost): HTMLElement {
		const host = this._postsEl;
		if (!host) {
			throw new Error("论坛帖子容器不可用");
		}
		const item = host.createDiv({ cls: "op-forum-post" });
		item.setAttr("data-post-id", String(post.id));
		const head = item.createDiv({ cls: "op-forum-post-head" });
		head.createSpan({
			cls: "op-forum-post-author",
			text: post.username || "匿名",
		});
		if (post.post_number === 1) {
			head.createSpan({ cls: "op-forum-post-badge", text: "楼主" });
		}
		head.createSpan({
			cls: "op-forum-post-time",
			text: this._formatDateTime(post.created_at),
		});
		const content = item.createDiv({ cls: "op-forum-post-body" });
		const fragment = sanitizeHTMLToDom(post.cooked);
		this._stripDiscourseLightboxes(fragment);
		content.appendChild(fragment);
		this._renderPostActions(item, post);
		return item;
	}

	private _renderPostActions(parent: HTMLElement, post: ForumPost): void {
		const actions = parent.createDiv({ cls: "op-forum-post-actions" });
		const like = actions.createEl("button", {
			cls: "op-forum-action",
			attr: { type: "button", "aria-label": "点赞" },
		});
		const summary = post.actions_summary?.find(
			(action) => action.id === 2,
		);
		const liked = !!summary?.acted;
		const count = summary?.count ?? 0;
		like.toggleClass("is-liked", liked);
		const likeIcon = like.createSpan({ cls: "op-forum-action-icon" });
		setIcon(likeIcon, "heart");
		like.createSpan({
			cls: "op-forum-action-count",
			text: String(count),
		});
		like.setAttr("aria-pressed", liked ? "true" : "false");
		setTooltip(like, liked ? "取消点赞" : "点赞");
		like.addEventListener("click", () => {
			void this._toggleLike(post, like);
		});
		const reply = actions.createEl("button", {
			cls: "op-forum-action",
			attr: { type: "button", "aria-label": "回复" },
		});
		const replyIcon = reply.createSpan({ cls: "op-forum-action-icon" });
		setIcon(replyIcon, "message-square");
		reply.createSpan({ text: "回复" });
		setTooltip(reply, "回复");
		reply.addEventListener("click", () => {
			this._openComposer(post, parent);
		});
		parent.createDiv({ cls: "op-forum-composer-host" });
	}

	private async _toggleLike(
		post: ForumPost,
		btn: HTMLButtonElement,
	): Promise<void> {
		const session = this._authSession;
		if (!session) {
			this._openAuth();
			return;
		}
		if (btn.disabled) {
			return;
		}
		if (
			post.username &&
			post.username.toLowerCase() === session.username.toLowerCase()
		) {
			new Notice("不能给自己的帖子点赞");
			return;
		}
		const liked = btn.classList.contains("is-liked");
		btn.disabled = true;
		try {
			const response = liked
				? await this._write<ForumPost>(
						`/post_actions/${post.id}.json`,
						"DELETE",
						{ post_action_type_id: 2 },
					)
				: await this._write<ForumPost>(
						"/post_actions.json",
						"POST",
						{
							id: post.id,
							post_action_type_id: 2,
							flag_topic: false,
						},
					);
			const summary = response.actions_summary?.find(
				(action) => action.id === 2,
			);
			const nextLiked = summary?.acted ?? !liked;
			const nextCount =
				summary?.count ??
				Math.max(
					0,
					Number(btn.dataset.count ?? "0") +
						(nextLiked ? 1 : -1),
				);
			btn.toggleClass("is-liked", nextLiked);
			btn.dataset.count = String(nextCount);
			btn.setAttr("aria-pressed", nextLiked ? "true" : "false");
			const countEl = btn.querySelector(".op-forum-action-count");
			if (countEl) {
				countEl.setText(String(nextCount));
			}
			setTooltip(btn, nextLiked ? "取消点赞" : "点赞");
		} catch (error) {
			new Notice(this._actionError(error));
		} finally {
			btn.disabled = false;
		}
	}

	private _openComposer(post: ForumPost, postEl: HTMLElement): void {
		if (!this._authSession) {
			this._openAuth();
			return;
		}
		const host = postEl.querySelector(".op-forum-composer-host");
		if (!(host instanceof HTMLElement)) {
			return;
		}
		const existing = host.querySelector(".op-forum-composer");
		if (existing instanceof HTMLElement) {
			existing.querySelector("textarea")?.focus();
			return;
		}
		host.empty();
		const composer = host.createDiv({ cls: "op-forum-composer" });
		const head = composer.createDiv({
			cls: "op-forum-composer-head",
		});
		head.createSpan({ text: "回复 " });
		head.createEl("b", { text: post.username || "匿名" });
		const textarea = composer.createEl("textarea", {
			cls: "op-forum-composer-input",
		});
		textarea.placeholder = "写下你的回复…";
		textarea.rows = 3;
		const errorEl = composer.createDiv({
			cls: "op-forum-composer-error",
		});
		errorEl.hidden = true;
		const actions = composer.createDiv({
			cls: "op-forum-composer-actions",
		});
		const cancel = actions.createEl("button", { text: "取消" });
		cancel.addEventListener("click", () => composer.remove());
		const send = actions.createEl("button", {
			text: "发送",
			cls: "mod-cta",
		});
		send.addEventListener("click", () => {
			void this._sendReply(post, composer, textarea, send, errorEl);
		});
		textarea.focus();
	}

	private async _sendReply(
		post: ForumPost,
		composer: HTMLElement,
		textarea: HTMLTextAreaElement,
		send: HTMLButtonElement,
		errorEl: HTMLElement,
	): Promise<void> {
		const raw = textarea.value.trim();
		if (!raw) {
			textarea.focus();
			return;
		}
		const topicId = this._currentTopicId;
		if (topicId === null) {
			return;
		}
		send.disabled = true;
		send.setText("发送中…");
		errorEl.hidden = true;
		try {
			const response = await this._write<ForumPost>(
				"/posts.json",
				"POST",
				{
					topic_id: topicId,
					raw,
					reply_to_post_number: post.post_number,
				},
			);
			composer.remove();
			const reply: ForumPost = {
				id: response.id,
				username:
					response.username ||
					this._authSession?.username ||
					"我",
				created_at: response.created_at,
				cooked: response.cooked,
				post_number: response.post_number,
				actions_summary: response.actions_summary,
			};
			if (reply.cooked) {
				const [element] = this._appendPosts([reply]);
				this._localReplyEl = element ?? null;
				if (this._topicStreamLength > 0) {
					this._topicStreamLength += 1;
				}
				element?.scrollIntoView({ block: "nearest" });
			}
			new Notice("回复已发送");
		} catch (error) {
			errorEl.setText(this._actionError(error));
			errorEl.hidden = false;
		} finally {
			if (composer.isConnected) {
				send.disabled = false;
				send.setText("发送");
			}
		}
	}

	private async _write<T>(
		path: string,
		method: "POST" | "DELETE",
		body: unknown,
	): Promise<T> {
		const session = this._authSession;
		if (!session) {
			throw new Error("请先登录论坛账号。");
		}
		const response = await withTimeout(
			requestUrl({
				url: `${FORUM_BASE}${path}`,
				method,
				contentType: "application/json",
				body: JSON.stringify(body),
				headers: this._headers(session),
				throw: false,
			}),
			FORUM_TIMEOUT_MS,
		);
		if (response.status === 403) {
			const valid = await this._authStillValid(session);
			if (!valid) {
				throw new Error("论坛授权已失效，请重新登录。");
			}
		}
		if (response.status >= 300) {
			let errors: string[] | undefined;
			try {
				errors = (
					response.json as { errors?: string[] } | null
				)?.errors;
			} catch {
				// 非 JSON 错误页：退回状态码。
			}
			throw new Error(
				response.status === 429
					? "操作太频繁，请稍后再试。"
					: (errors?.[0] ?? `HTTP ${response.status}`),
			);
		}
		try {
			return response.json as T;
		} catch {
			throw new Error("论坛返回了非 JSON 响应，请稍后重试。");
		}
	}

	private async _authStillValid(
		session: ForumAuthSession,
	): Promise<boolean> {
		try {
			const response = await withTimeout(
				requestUrl({
					url: `${FORUM_BASE}/session/current.json`,
					headers: this._headers(session),
					throw: false,
				}),
				FORUM_TIMEOUT_MS,
			);
			if (response.status !== 403) {
				return true;
			}
		} catch {
			return true;
		}
		try {
			clearForumAuth(this.app);
		} catch {
			// 本地清理失败时仍把界面切回未登录，钥匙可在论坛侧撤销。
		}
		this._authSession = null;
		this._updateAuthEntry();
		return false;
	}

	private _actionError(error: unknown): string {
		return error instanceof Error && error.message
			? error.message
			: "操作失败，请稍后重试。";
	}

	/** 论坛 `lightbox-wrapper` 内的 `lightbox`/`meta` 类与 Obsidian 全局
	 * `.lightbox` 撞名：宿主样式会把图链绝对定位成超宽块，撑破帖子容器
	 * （主题 273 实测，2026-11-20）。渲染前拆成普通图片链接，去掉图库元信息。 */
	private _stripDiscourseLightboxes(fragment: DocumentFragment): void {
		for (const wrapper of Array.from(
			fragment.querySelectorAll(".lightbox-wrapper"),
		)) {
			const link = wrapper.querySelector("a.lightbox");
			const img = wrapper.querySelector("img");
			if (!img) {
				wrapper.remove();
				continue;
			}
			wrapper.querySelectorAll(".meta").forEach((meta) => meta.remove());
			if (!link) {
				wrapper.replaceWith(img);
				continue;
			}
			link.className = "op-forum-image-link";
			link.appendChild(img);
			wrapper.replaceWith(link);
		}
	}

	private _startObserving(): void {
		this._disconnectObserver();
		if (this._postsDrained || !this._sentinelEl) {
			return;
		}
		this._observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					void this._loadMoreTopic();
				}
			},
			{ rootMargin: "400px 0px" },
		);
		this._observer.observe(this._sentinelEl);
	}

	private async _loadMoreTopic(): Promise<void> {
		const detail = this._currentTopic;
		const sentinel = this._sentinelEl;
		if (
			!detail ||
			!sentinel ||
			this._loadingMore ||
			this._postsDrained
		) {
			return;
		}
		this._loadingMore = true;
		this._observer?.unobserve(sentinel);
		const status = this._bodyEl?.createDiv({
			cls: "op-forum-more",
			text: "正在加载更多…",
		});
		if (status) {
			this._footerEl?.before(status);
		}
		let failed = false;
		try {
			// Discourse 的 topic page=1 与 page=0 返回同一段；后续分段从
			// page=2 开始（按 post_number 窗口），不能简单 +1。
			const nextPage =
				this._currentTopicPage === 0 ? 2 : this._currentTopicPage + 1;
			const next = await this._fetchTopic(detail.id, nextPage);
			if (this._currentTopicId !== detail.id || this._disposed) {
				return;
			}
			this._currentTopicPage = nextPage;
			const before = this._loadedPostIds.size;
			this._appendPosts(
				next.post_stream?.posts ?? [],
				this._localReplyEl,
			);
			const streamLength = next.post_stream?.stream?.length;
			if (typeof streamLength === "number" && streamLength > 0) {
				this._topicStreamLength = Math.max(
					this._topicStreamLength,
					streamLength,
				);
			}
			if (
				this._loadedPostIds.size === before ||
				this._loadedPostIds.size >= this._topicStreamLength
			) {
				this._postsDrained = true;
				this._disconnectObserver();
			}
		} catch {
			failed = true;
			if (status) {
				status.setText("加载更多失败，点击重试");
				status.addClass("is-error");
				status.addEventListener("click", () => {
					status.remove();
					void this._loadMoreTopic();
				});
			}
		} finally {
			this._loadingMore = false;
			if (status && !failed) {
				status.remove();
			}
			if (!failed && !this._postsDrained) {
				this._startObserving();
			}
		}
	}

	private async _refreshCurrent(): Promise<void> {
		if (this._currentTopicId !== null) {
			await this._openTopicById(this._currentTopicId);
			return;
		}
		await this._loadList();
	}

	private _goBack(): void {
		if (this._currentTopicId === null) {
			return;
		}
		this._currentTopicId = null;
		this._currentTopic = null;
		this._disconnectObserver();
		this._setBackEnabled(false);
		this._restoreScrollTop = this._listScrollTop;
		void this._loadList();
	}

	private _openCurrentInBrowser(): void {
		if (this._currentTopicId !== null) {
			openExternal(`${FORUM_BASE}/t/${this._currentTopicId}`);
			return;
		}
		openExternal(this._currentBrowseUrl());
	}

	private _currentBrowseUrl(): string {
		if (this._query) {
			return `${FORUM_BASE}/search?q=${encodeURIComponent(this._query)}`;
		}
		if (this._selectedCategoryId !== null) {
			return `${FORUM_BASE}/c/${this._selectedCategoryId}`;
		}
		return `${FORUM_BASE}/latest`;
	}

	private _categoryName(categoryId: number): string {
		return this._categoryNames.get(categoryId) ?? "论坛";
	}

	private _relativeTime(iso: string): string {
		const time = Date.parse(iso);
		if (!Number.isFinite(time)) {
			return "";
		}
		const diff = Date.now() - time;
		if (diff < 0) {
			return "刚刚";
		}
		const minute = 60 * 1000;
		const hour = 60 * minute;
		const day = 24 * hour;
		if (diff < minute) {
			return "刚刚";
		}
		if (diff < hour) {
			return `${Math.floor(diff / minute)} 分钟前`;
		}
		if (diff < day) {
			return `${Math.floor(diff / hour)} 小时前`;
		}
		if (diff < 2 * day) {
			return "昨天";
		}
		if (diff < 30 * day) {
			return `${Math.floor(diff / day)} 天前`;
		}
		if (diff < 365 * day) {
			return `${Math.floor(diff / (30 * day))} 个月前`;
		}
		return `${Math.floor(diff / (365 * day))} 年前`;
	}

	private _formatDateTime(iso: string): string {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) {
			return "";
		}
		const pad = (value: number): string => String(value).padStart(2, "0");
		return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(
			date.getHours(),
		)}:${pad(date.getMinutes())}`;
	}

	private _renderStatus(text: string): void {
		const body = this._bodyEl;
		if (!body) {
			return;
		}
		body.empty();
		body.createDiv({ cls: "op-forum-status", text });
	}

	private _renderError(message: string, retry: () => void): void {
		const body = this._bodyEl;
		if (!body) {
			return;
		}
		body.empty();
		body.createDiv({
			cls: "op-forum-status is-error",
			text: message,
		});
		const actions = body.createDiv({
			cls: "op-forum-error-actions",
		});
		const retryBtn = actions.createEl("button", {
			text: "重试",
			cls: "op-forum-retry",
		});
		retryBtn.addEventListener("click", retry);
		const link = actions.createEl("a", {
			cls: "op-forum-link",
			text: "在浏览器打开",
			href: FORUM_BASE,
		});
		link.addEventListener("click", (event) => {
			event.preventDefault();
			openExternal(FORUM_BASE);
		});
	}

	private async _api<T>(path: string): Promise<T> {
		const response = await withTimeout(
			requestUrl({ url: `${FORUM_BASE}${path}` }),
			FORUM_TIMEOUT_MS,
		);
		if (response.status >= 300) {
			throw new Error(`HTTP ${response.status}`);
		}
		return response.json as T;
	}

	private _disconnectObserver(): void {
		this._observer?.disconnect();
		this._observer = null;
	}

	private _clearSearchTimer(): void {
		if (this._searchTimer !== null) {
			window.clearTimeout(this._searchTimer);
			this._searchTimer = null;
		}
	}

	private readonly _onContentClick = (event: MouseEvent): void => {
		const target = event.target as HTMLElement | null;
		const anchor = target?.closest("a");
		if (!anchor || !anchor.closest(".op-forum-post-body")) {
			return;
		}
		const href = anchor.getAttribute("href");
		if (!href) {
			return;
		}
		event.preventDefault();
		try {
			openExternal(new URL(href, FORUM_BASE).href);
		} catch {
			// 非法链接不处理
		}
	};
}
