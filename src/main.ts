import { addIcon, Notice, Platform, Plugin, WorkspaceLeaf } from "obsidian";

import { VIEW_TYPE_FORUM, VIEW_TYPE_PICKER } from "./consts";
import { ForumView, openForumView } from "./forum-view";
import { loadPresetTranslations } from "./preset-translations";
import { OpenplugSettingTab } from "./setting";
import { OpenplugPickerView } from "./view";

const SHOW_PLUGIN_ACTION = "show-plugin";
const SHOW_THEME_ACTION = "show-theme";
/** 桥接管窗口内隐藏官方详情弹层的 body 类（见 styles.css）。 */
const OPENPLUG_HIDE_MODALS_CLASS = "op-hide-modals";
const OPENPLUG_ANDROID_CLASS = "op-android";
const OPENPLUG_IOS_CLASS = "op-ios";
/** 冷启动后置激活的让位时长：等其它插件（如 Resojot）的默认视图先开完。 */
const COLD_START_SETTLE_MS = 500;
/** 冷启动焦点轮询：间隔与最大次数（窗口约 200ms × 8 = 1.6s 内有限重夺）。 */
const COLD_START_RECLAIM_INTERVAL_MS = 200;
const COLD_START_RECLAIM_MAX_ATTEMPTS = 8;
/** 预置简翻刷新延后：等宿主自身启动与首屏渲染过去，再占网络与主线程。 */
const PRESET_REFRESH_DELAY_MS = 2000;
/** 官方社区 integrations 图标；宿主把 `blocks` 别名成 layout-list，故用前缀独立注册。 */
const OPENPLUG_BLOCKS_ICON = "op-blocks";
/** Lucide 为 24 视口，addIcon 的自定义图标固定 100 视口，故按 100/24 放大。 */
const OPENPLUG_BLOCKS_SVG =
	'<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="scale(4.1666667)"><path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2"></path><rect x="14" y="2" width="8" height="8" rx="1"></rect></g>';

type ProtocolCallback = (params: Record<string, string>) => void;

interface ProtocolRegistry {
	handlers: Map<string, ProtocolCallback>;
}

interface AppWithProtocol {
	workspace: {
		protocolHandler: ProtocolRegistry;
	};
}

/** Capacitor App 插件桥（Obsidian 移动端为 Capacitor 应用，见 DECISIONS）。 */
interface CapacitorAppLike {
	addListener?: (
		eventName: string,
		callback: (data: unknown) => void,
	) => { remove?: () => void } | undefined;
	getLaunchUrl?: () => Promise<{ url?: string } | null | undefined>;
}

interface CapacitorLike {
	registerPlugin?: (name: string) => CapacitorAppLike | undefined;
	Plugins?: Record<string, CapacitorAppLike>;
	plugins?: Record<string, CapacitorAppLike>;
}

/**
 * 手写解析 obsidian:// 前缀（`URL.host` 对 obsidian 协议解析为空，
 * 探针实测见开发日志 20260828-2045）。
 */
function parseObsidianUrl(
	url: string,
): { action: string; params: Record<string, string> } | null {
	if (!url.startsWith("obsidian://")) {
		return null;
	}
	const rest = url.slice("obsidian://".length).split("#")[0];
	const questionIndex = rest.indexOf("?");
	const action = questionIndex >= 0 ? rest.slice(0, questionIndex) : rest;
	const query = questionIndex >= 0 ? rest.slice(questionIndex + 1) : "";
	const params: Record<string, string> = {};
	for (const pair of query.split("&")) {
		if (!pair) {
			continue;
		}
		const equalIndex = pair.indexOf("=");
		const key = equalIndex >= 0 ? pair.slice(0, equalIndex) : pair;
		const value = equalIndex >= 0 ? pair.slice(equalIndex + 1) : "";
		try {
			params[decodeURIComponent(key)] = decodeURIComponent(value);
		} catch {
			params[key] = value;
		}
	}
	return { action, params };
}

export default class OpenplugPlugin extends Plugin {
	private _originalHandlers: Map<string, ProtocolCallback | undefined> = new Map();
	private _hijackHandlers: Map<string, ProtocolCallback> = new Map();
	/** 安卓桥监听句柄；卸载时移除，避免卸载后仍接管。 */
	private _bridgeHandle: { remove?: () => void } | null = null;
	/**
	 * 处理级去重：同一目标短窗口（3s）内只处理一次。两层共用——
	 * 桥通道 `url:` 前缀防 getLaunchUrl 与 appUrlOpen 双投同一 URL；
	 * 劫持通道与桥通道可能先后收到同一插件/主题（iOS 双轨并行双收），
	 * 用 `plugin:`/`theme:` 前缀兜住，避免安装器重复打开/重复载入。
	 */
	private _lastHandled: { key: string; at: number } | null = null;

	async onload(): Promise<void> {
		addIcon(OPENPLUG_BLOCKS_ICON, OPENPLUG_BLOCKS_SVG);
		this._schedulePresetRefresh();
		this.registerView(
			VIEW_TYPE_PICKER,
			(leaf: WorkspaceLeaf) => new OpenplugPickerView(leaf),
		);
		this.registerView(
			VIEW_TYPE_FORUM,
			(leaf: WorkspaceLeaf) => new ForumView(leaf),
		);
		this.addSettingTab(new OpenplugSettingTab(this.app, this));

		// 入口与接管解耦：注册表缺失的设备（如安卓 1.12.7）也能使用安装器。
		this.addRibbonIcon("shopping-cart", "打开 OpenPlug 安装器", () => {
			void this.openView();
		});
		this.addCommand({
			id: "open-installer",
			name: "打开插件/主题安装器",
			callback: () => {
				void this.openView();
			},
		});
		this.addCommand({
			id: "open-forum",
			name: "打开中文论坛",
			callback: () => {
				void openForumView(this.app);
			},
		});

		this._acquireProtocol();

		// 移动端亮色表面兼容开关：宿主 CSS 无安卓/iOS 平台类，由插件判定后
		// 挂 body 语义类，供 styles.css 的亮色回指规则命中；卸载时摘除。
		// 2026-09-18 用户裁定先只做安卓；2026-10-24 iPhone 1.14 亮色真机复报
		// 白底白卡（日志 20261024-172042），用户授权扩到 iOS。
		if (Platform.isAndroidApp) {
			document.body.classList.add(OPENPLUG_ANDROID_CLASS);
		}
		if (Platform.isIosApp) {
			document.body.classList.add(OPENPLUG_IOS_CLASS);
		}
	}

	onunload(): void {
		document.body.classList.remove(OPENPLUG_ANDROID_CLASS, OPENPLUG_IOS_CLASS);
		const handle = this._bridgeHandle;
		if (handle && typeof handle.remove === "function") {
			try {
				handle.remove();
			} catch {
				// 移除失败不阻断卸载
			}
			this._bridgeHandle = null;
		}
		const registry = this._protocolRegistry();
		if (!registry) {
			return;
		}
		for (const [action, hijack] of this._hijackHandlers) {
			if (registry.handlers.get(action) === hijack) {
				const original = this._originalHandlers.get(action);
				if (original) {
					registry.handlers.set(action, original);
				} else {
					registry.handlers.delete(action);
				}
			}
		}
	}

	/**
	 * 预置简翻刷新挪出启动窗口：缓存命中时 `loadPresetTranslations` 只读一次
	 * localStorage 就返回；缓存过期时会同时向 raw + 4 镜像发请求，放在
	 * onload 里会和宿主自身启动、清单加载抢带宽。等布局就绪后再起跑，
	 * 用户此时已经能看见界面，译文行仍在本轮内补齐。
	 */
	private _schedulePresetRefresh(): void {
		const run = (): void => {
			void loadPresetTranslations();
		};
		const workspace = this.app.workspace;
		if (workspace.layoutReady) {
			// 布局已就绪（热重载插件）：让出一拍即可，不必再等
			this.registerInterval(window.setTimeout(run, PRESET_REFRESH_DELAY_MS));
			return;
		}
		workspace.onLayoutReady(() => {
			this.registerInterval(window.setTimeout(run, PRESET_REFRESH_DELAY_MS));
		});
	}

	/**
	 * 完成协议接管（双轨并行，互不短路）：
	 * - 注册表劫持（桌面/iOS 主路）：首检命中即挂；未命中等布局就绪补查
	 *   （注册表可能晚于插件加载建立）。
	 * - Capacitor 桥（移动端主路）：**无论劫持是否命中都挂载**——iOS
	 *   冷启动时 appUrlOpen 事件可能在 webview 未就绪前已丢失（Obsidian
	 *   官方弹层也不弹，见开发日志 20260828-2045 追加十二），劫持命中
	 *   也等不到分发；桥的 `getLaunchUrl()` 读原生侧 lastURL，不依赖
	 *   webview JS，是 iOS 冷启动唯一存活入口，不能因劫持命中而跳过。
	 * 双路皆缺（无注册表且无 Capacitor 桥）才提示降级。
	 */
	private _acquireProtocol(): void {
		this._tryHijack();
		const bridgeOk = this._attachCapacitorBridge();
		void this._waitForWorkspaceReady().then(() => {
			if (!bridgeOk && !this._tryHijack()) {
				new Notice("未找到协议注册表，自动接管未生效");
			}
		});
	}

	/** 注册表就绪即接管 show-plugin/show-theme；未就绪返回 false。 */
	private _tryHijack(): boolean {
		const registry = this._protocolRegistry();
		if (!registry) {
			return false;
		}
		this._hijackAction(registry, SHOW_PLUGIN_ACTION, (p) =>
			this._handleShowPlugin(p),
		);
		this._hijackAction(registry, SHOW_THEME_ACTION, (p) =>
			this._handleShowTheme(p),
		);
		return true;
	}

	/** 挂载 Capacitor App 插件 appUrlOpen 监听（安卓/iOS 接管路径）。
	 * 桌面跳过：Obsidian 桌面构建也带 window.Capacitor，但 App 插件为
	 * web 占位实现——每次热重载实测都会经内部错误通道记录
	 * `"App" plugin is not implemented on web`（addListener / getLaunchUrl）
	 * 与卸载期 remove() 的 TypeError，且该通道不受调用方 try/catch 抑制；
	 * 桌面主路是注册表劫持，桥无作用（2026-08-30 实测取证）。 */
	private _attachCapacitorBridge(): boolean {
		if (Platform.isDesktop) {
			return false;
		}
		const capacitor = (window as unknown as { Capacitor?: CapacitorLike }).Capacitor;
		if (!capacitor) {
			return false;
		}
		let appPlugin: CapacitorAppLike | undefined;
		try {
			if (typeof capacitor.registerPlugin === "function") {
				appPlugin = capacitor.registerPlugin("App");
			} else {
				appPlugin = capacitor.Plugins?.["App"] ?? capacitor.plugins?.["App"];
			}
		} catch {
			return false;
		}
		if (!appPlugin || typeof appPlugin.addListener !== "function") {
			return false;
		}
		try {
			const handle = appPlugin.addListener("appUrlOpen", (data) => {
				const url = (data as { url?: unknown }).url;
				if (typeof url === "string") {
					this._handleBridgeUrl(url);
				}
			});
			this._bridgeHandle = handle ?? null;
			// 冷启动：由链接拉起 App 时，appUrlOpen 可能在插件加载前已投递，
			// 用 getLaunchUrl() 补取启动 URL（Capacitor 标准冷启动模式，
			// 实测见开发日志 20260828-2045 追加六）。
			const launchUrl = appPlugin.getLaunchUrl?.();
			if (launchUrl) {
				// 不接 rejection 会留未处理拒绝（旧版桥/占位实现会 reject，
				// 桌面实测见 attachCapacitorBridge 注）；收尾只保证不炸日志。
				void launchUrl.then((launch) => {
					const url = launch?.url;
					if (typeof url === "string") {
						this._handleBridgeUrl(url);
					}
				}).catch(() => {});
			}
			return true;
		} catch {
			return false;
		}
	}

	/** 处理桥投递的完整 obsidian:// URL（去重 + 解析 + 复用现役接管逻辑）。 */
	private _handleBridgeUrl(url: string): void {
		if (this._dupHandled("url:" + url)) {
			return;
		}
		const parsed = parseObsidianUrl(url);
		if (!parsed) {
			return;
		}
		if (parsed.action === SHOW_PLUGIN_ACTION || parsed.action === SHOW_THEME_ACTION) {
			// 桥接管后 Obsidian 自身仍会收到同一事件并走官方分发，需抑制
			// 官方详情弹层（见 suppressOfficialSheet）；劫持通道不触发抑制
			// ——注册表分发已替换为我们的 handler，官方不再自弹。
			if (parsed.action === SHOW_PLUGIN_ACTION) {
				this._handleShowPlugin(parsed.params);
			} else {
				this._handleShowTheme(parsed.params);
			}
			this._suppressOfficialSheet();
		}
	}

	/**
	 * 抑制官方社区详情弹层：桥接管后 Obsidian 自身仍会创建官方插件详情
	 * sheet。关键机制——Obsidian 与我们同在一次同步派发批次内先后收到
	 * appUrlOpen，浏览器绘制发生在该批次之后，因此在本监听里同步加
	 * `op-hide-modals` 类（styles.css），官方弹层即使被创建也
	 * **从未被绘制**（用户目标：不弹，而非缩短闪跳；实测见开发日志）。
	 * 随后轮询走 Obsidian 自己的关闭流程清理模态状态；只关闭捕获后新
	 * 出现的容器，避免误关用户已打开的弹窗；隐藏类在关闭后或 2s 兜底
	 * 移除，不影响后续正常弹窗。
	 */
	private _suppressOfficialSheet(): void {
		const preexisting = new Set(
			Array.from(document.querySelectorAll(".modal-container")),
		);
		document.body.classList.add(OPENPLUG_HIDE_MODALS_CLASS);
		let attempts = 0;
		let closed = false;
		const tryClose = (): void => {
			attempts += 1;
			document.querySelectorAll(".modal-container").forEach((container) => {
				if (preexisting.has(container) || closed) {
					return;
				}
				const closeButton = container.querySelector(".modal-close-button");
					if (closeButton instanceof HTMLElement) {
						closeButton.click();
						closed = true;
						this.registerInterval(
							window.setTimeout(
								() => document.body.classList.remove(OPENPLUG_HIDE_MODALS_CLASS),
								300,
							),
						);
					}
				});
				if (!closed && attempts < 20) {
					this.registerInterval(window.setTimeout(tryClose, 100));
				}
			};
			this.registerInterval(window.setTimeout(tryClose, 100));
			// 兜底移除隐藏类也挂插件级定时器：插件卸载（热重载/禁用）时随
			// registerInterval 一并清理，旧实例回调不再改动新会话的 body 类。
			this.registerInterval(
				window.setTimeout(
					() => document.body.classList.remove(OPENPLUG_HIDE_MODALS_CLASS),
					2000,
				),
			);
		}

	private _hijackAction(
		registry: ProtocolRegistry,
		action: string,
		handler: ProtocolCallback,
	): void {
		const current = registry.handlers.get(action);
		const mine = this._hijackHandlers.get(action);
		if (mine && current === mine) {
			// 幂等：已挂且注册表里仍是我们的接管（首检命中 + 布局后补查
			// 双轨并行会重复进入），跳过覆盖，避免 originalHandlers 被
			// 二次采样成我们自己的 handler。
			return;
		}
		this._originalHandlers.set(action, current);
		// handler 本身即需登记与对比的引用（onunload 凭同一引用判断
		// 注册表里还是我们的接管），无需身份包装。
		this._hijackHandlers.set(action, handler);
		registry.handlers.set(action, handler);
	}

	private _protocolRegistry(): ProtocolRegistry | null {
		const app = this.app as unknown as AppWithProtocol;
		return app.workspace?.protocolHandler?.handlers
			? app.workspace.protocolHandler
			: null;
	}

	/**
	 * 处理级去重：`key` 短窗口（3s）内只放行一次。桥通道按 `url:`、
	 * 目标按 `plugin:`/`theme:` 加键，覆盖双轨并行下的所有重复投递。
	 */
	private _dupHandled(key: string): boolean {
		const now = Date.now();
		if (
			this._lastHandled &&
			this._lastHandled.key === key &&
			now - this._lastHandled.at < 3000
		) {
			return true;
		}
		this._lastHandled = { key, at: now };
		return false;
	}

	private _handleShowPlugin(params: Record<string, string>): void {
		const pluginId = params?.id ?? "";
		if (!pluginId) {
			new Notice("链接缺少插件 id");
			return;
		}
		if (this._dupHandled("plugin:" + pluginId)) {
			return;
		}
		void this._openPicker(pluginId, "plugin");
	}

	private _handleShowTheme(params: Record<string, string>): void {
		const themeName = params?.name ?? "";
		if (!themeName) {
			new Notice("链接缺少主题 name");
			return;
		}
		if (this._dupHandled("theme:" + themeName)) {
			return;
		}
		void this._openPicker(themeName, "theme");
	}

	async openView(): Promise<void> {
		const workspace = this.app.workspace;
		if (workspace.getLeavesOfType(VIEW_TYPE_PICKER).length === 0) {
			const leaf = workspace.getLeaf(true);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_PICKER, active: false });
			}
		}
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_PICKER);
		const leaf = leaves.length > 0 ? leaves[0] : null;
		if (leaf) {
			// revealLeaf 只负责展开侧栏/选中 tab，不会把该 leaf 设为活动
			// leaf 或聚焦容器（Obsidian 自身 ensureSideLeaf 也是两者成对使用）；
			// 不补 setActiveLeaf 时，视图已打开再点入口会"没反应"。
			await workspace.revealLeaf(leaf);
			workspace.setActiveLeaf(leaf, { focus: true });
		}
	}

	/**
	 * 冷启动（链接直接拉起 Obsidian）时，桥捕获可能早于工作区布局就绪，
	 * 此时 `getLeaf`/`setViewState` 拿不到可用叶子——用户实测表现为
	 * "只提示已捕获、安装器不弹出"。等布局就绪后再开视图，2s 兜底防挂起。
	 * 返回是否实际等待过（等待过 = 冷启动路径，由调用方做后置激活处理）。
	 */
	private _waitForWorkspaceReady(): Promise<boolean> {
		const workspace = this.app.workspace;
		if (workspace.layoutReady) {
			return Promise.resolve(false);
		}
		return new Promise((resolve) => {
			workspace.onLayoutReady(() => resolve(true));
			// 2s 兜底防挂起；挂插件级定时器，卸载时一并清理
			//（promise 不再 resolve 属预期：实例已卸载，链路无人等待）。
			this.registerInterval(window.setTimeout(() => resolve(true), 2000));
		});
	}

	private async _openPicker(
		identifier: string,
		kind: "plugin" | "theme",
	): Promise<void> {
		const coldStart = await this._waitForWorkspaceReady();
		if (coldStart) {
			// 其它插件（如 Resojot）也会在布局就绪后打开默认视图并抢焦点；
			// 让出一拍等它们先开完，我们再打开并激活自己（最后激活者可见，
			// 用户实测冷启动会被这类插件覆盖）。
			await new Promise((resolve) => {
				this.registerInterval(
					window.setTimeout(resolve, COLD_START_SETTLE_MS),
				);
			});
		}
		const workspace = this.app.workspace;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_PICKER);
		let leaf: WorkspaceLeaf | null = leaves.length > 0 ? leaves[0] : null;
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			if (!leaf) {
				return;
			}
			await leaf.setViewState({ type: VIEW_TYPE_PICKER, active: true });
		}
		await workspace.revealLeaf(leaf);
		workspace.setActiveLeaf(leaf, { focus: true });
		const view = leaf.view;
		if (view instanceof OpenplugPickerView) {
			if (kind === "plugin") {
				void view.loadFor(identifier);
			} else {
				void view.loadTheme(identifier);
			}
		}
		if (coldStart) {
			this._reclaimFocus(0);
		}
	}

	/**
	 * 冷启动后置保护：短窗口内**有限次轮询**焦点——活动视图不是安装器
	 * 且安装器仍在（可能被其它插件默认视图二次抢占）就重夺；到次数或
	 * 安装器被关闭即停止（有界轮询，不与其它插件无限拉扯。用户实测
	 * 事件式单次重夺足以覆盖 Resojot，轮询式为更稳的升级）。
	 */
	private _reclaimFocus(attempt: number): void {
		const workspace = this.app.workspace;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_PICKER);
		const leaf = leaves.length > 0 ? leaves[0] : null;
		if (!leaf || attempt >= COLD_START_RECLAIM_MAX_ATTEMPTS) {
			return;
		}
		const getActive = (workspace as unknown as {
			getActiveLeaf?: () => WorkspaceLeaf | null;
		}).getActiveLeaf;
		if (typeof getActive !== "function") {
			return;
		}
		const active = getActive.call(workspace);
		if (active !== leaf) {
			workspace.setActiveLeaf(leaf, { focus: true });
		}
		this.registerInterval(
			window.setTimeout(() => this._reclaimFocus(attempt + 1), COLD_START_RECLAIM_INTERVAL_MS),
		);
	}
}
