import {
	App,
	ButtonComponent,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	setIcon,
} from "obsidian";

import type OpenplugPlugin from "./main";
import { MIRRORS, probeMirrorsHealth } from "./mirror";
import {
	SETTINGS_ROOT_PAGE,
	SETTINGS_TAB_ICON,
	decorateSettingsRootRowIcons,
} from "./settings-root-icons";
import { openExternal } from "./util";

/** 作者 GitHub 仓库（与 README / Release 地址一致）。 */
const GITHUB_URL = "https://github.com/jiaoyingxing/openplug";
/** 作者小红书主页固定用户 ID 链接（与 Easy-Sync / Square 保持一致）。 */
const XIAOHONGSHU_URL =
	"https://www.xiaohongshu.com/user/profile/605dfc23000000000101cfdb";
/** BRAT 在官方社区目录的详情页深度链接（由宿主协议接管打开）。 */
const BRAT_URL = "obsidian://show-plugin?id=obsidian42-brat";

/** 「关于-作者」行的联系方式按钮（EasySync 同型照抄，2026-10-17 用户拍板）：
 *  图标＋短标签一体化小按钮，按钮原生空内容后自行挂 icon/label 两 span。 */
function configureAboutContactButton(
	button: ButtonComponent,
	options: {
		label: string;
		icon: string;
		url: string;
		extraClassName?: string;
	},
): void {
	button.setClass("op-settings-about-contact-button");
	button.setTooltip(options.label);
	button.buttonEl.setAttribute("aria-label", options.label);
	button.onClick(() => {
		window.open(options.url, "_blank", "noopener,noreferrer");
	});
	button.buttonEl.empty();
	if (options.extraClassName) {
		button.buttonEl.addClass(options.extraClassName);
	}
	const iconEl = button.buttonEl.createSpan({
		cls: "op-settings-about-contact-button-icon",
	});
	setIcon(iconEl, options.icon);
	button.buttonEl.createSpan({
		cls: "op-settings-about-contact-button-label",
		text: options.label,
	});
}

/**
 * 设置页（Obsidian ≥1.13 声明式）。静态信息行用 Empty 定义即可参与设置
 * 搜索；带按钮或动态内容的行用 render 回调命令式构建。
 *
 * `<1.13` 回落（2026-11-20 用户定）：旧版没有声明式设置树，点开插件设置
 * 不再渲染一套功能残缺的旧式页面，而是**直接进插件界面**（安装器）。
 * `minAppVersion` 因此保持 1.11.4，旧版照常可装可用。
 */
export class OpenplugSettingTab extends PluginSettingTab {
	plugin: OpenplugPlugin;

	/** 测速竞态序号：只让最后一次发起的测速写入结果，避免乱序覆盖。 */
	private _healthProbeSeq = 0;
	/** 镜像状态行句柄（重渲染时按下标刷新引用，不追加重复行）。 */
	private _probeRows: Setting[] = [];
	/** 自动测速触发标记：每次打开设置页重新武装，首渲染即启动一次。 */
	private _probeStarted = false;
	/** 根级导航行行首图标补挂观察器（1.13+ 声明式；unload 时由 plugin.register 断开）。 */
	private _rootRowIconObserver: MutationObserver | null = null;

	constructor(app: App, plugin: OpenplugPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		// 设置窗左栏页签图标：宿主默认隐藏第三方插件行的图标元素，由 styles.css
		// 按 data-setting-id 只放开本插件那一行（做法与姊妹插件 EasySync / Resojot 同源）。
		this.icon = SETTINGS_TAB_ICON;
		this._observeRootRowIcons();
	}

	/**
	 * 1.13+ 根级导航行的行首图标补挂。
	 *
	 * 宿主进子页再返回会重建根行、`update()` 不重建（EasySync 1.14.4 实测），
	 * 所以盯 `containerEl` 的 DOM 变化同步补挂；**不用 rAF 合帧**——设置窗在前台
	 * 时主窗 `document.hidden === true`，rAF 实测不触发。装饰只遍历容器内的
	 * `.setting-item`（根级 ≤4 行）且幂等，成本可忽略。
	 */
	private _observeRootRowIcons(): void {
		this._rootRowIconObserver = new MutationObserver(() => {
			this._decorateRootRowIcons();
		});
		this._rootRowIconObserver.observe(this.containerEl, {
			attributes: false,
			childList: true,
			characterData: false,
			subtree: true,
		});
		this.plugin.register(() => {
			this._rootRowIconObserver?.disconnect();
			this._rootRowIconObserver = null;
		});
	}

	/**
	 * `<1.13` 回落（2026-11-20 用户定）：点开插件设置即直接进插件界面。
	 *
	 * 旧版没有声明式设置树，渲染旧式页面只会露出残缺的一组行；用户要求
	 * 「点插件设置就直接打开插件界面」。先把设置收走再开面板——设置是
	 * modal / 满屏 pane，不收走会把安装器完全遮住（与「打开插件界面」
	 * 行同一处理，见 DECISIONS「打开插件界面行点击语义」）。
	 */
	display(): void {
		this.containerEl.empty();
		const settingsDialog = this.app as unknown as {
			setting: { close: () => void };
		};
		settingsDialog.setting.close();
		void this.plugin.openView();
	}

	/** 根级导航行行首图标补挂（仅声明式渲染有根级导航行）。 */
	private _decorateRootRowIcons(): void {
		const declarative = this as unknown as { settingItems?: unknown[] };
		if (
			declarative.settingItems === undefined
			|| declarative.settingItems.length === 0
		) {
			return;
		}
		decorateSettingsRootRowIcons(this.containerEl);
	}

	/**
	 * 声明式设置定义（Obsidian ≥1.13）：静态信息行用 Empty 定义即可参与
	 * 设置搜索；带按钮或动态内容的行用 render 回调命令式构建。
	 * 此方法每次打开设置页与建立搜索索引时都会被调用。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		// 容器作用域类在此补挂（幂等）。
		this.containerEl.addClass("op-settings-tab");
		// 重新武装自动测速：最后一镜像行渲染时触发（见 _renderMirrorRow）。
		this._probeStarted = false;
		// 根级＝两组（2026-10-17 用户拍板修订）：「打开插件界面」单独一组，三个
		// 子页一组；EasySync 2026-10-11 同型无标题轻分组。页内沿用各组原行序与
		// 文案直接平移（EasySync 维护页同型：页内裸行），页名承接原组标题语义，
		// 页内不再重复组标题。
		return [
			{
				type: "group",
				items: [
					{
						name: "打开插件界面",
						desc: "搜索并安装社区插件与主题。",
						render: (setting) => this._renderOpenRow(setting),
					},
				],
			},
			{
				type: "group",
				items: [
					{
						type: "page",
						name: SETTINGS_ROOT_PAGE.about,
						desc: "产品、作者与问题反馈。",
						items: [
							// EasySync 关于页三行同型照抄（2026-10-17 用户拍板）：
							// 产品名＋版本行、作者行（GitHub／小红书图标钮）、问题反馈行。
							{
								name: "OpenPlug",
								desc: `版本 ${this.plugin.manifest.version?.trim() || ""}`,
							},
							{
								name: "作者",
								desc: "焦应行（Jiao Yingxing）",
								render: (setting) => this._renderAuthorRow(setting),
							},
							{
								name: "问题反馈",
								desc: "使用中遇到问题，可在 GitHub 提交 Issue，或通过小红书私信联系我。",
							},
						],
					},
					{
						type: "page",
						name: SETTINGS_ROOT_PAGE.notice,
						desc: "隐私、来源、下载与风险提示。",
						items: [
							{
								name: "隐私",
								desc: "本插件开源，不收集你的数据，无遥测，无广告，不设账号。",
							},
							{
								name: "来源",
								desc: "所列的全部插件与主题均通过第三方 GitHub 镜像站点获取。",
							},
							{
								name: "下载",
								desc: "仅支持官方社区已上架的插件与主题。未上架的插件需用 BRAT 下载。（我做了汉化，已被作者合并）",
								render: (setting) => this._renderDownloadRow(setting),
							},
							{
								name: "风险提示",
								desc: "插件上架前虽然会有官方自动审核，但多数插件为个人开发者维护，无法确保质量。建议优先选用下载量大、长期稳定维护的插件。",
							},
							{
								name: "免责声明",
								desc: "下载与安装即代表你已知悉并自行承担由此带来的全部风险（包括但不限于数据丢失、设备安全、隐私泄露等）。",
							},
						],
					},
					{
						// 「高级」页承接原无标题镜像组：镜像测速为低频板块（原发布版设计
						// 勿补组标题的口径，由页名承接），页内行序不变。
						type: "page",
						name: SETTINGS_ROOT_PAGE.advanced,
						desc: "镜像测速与镜像源连通状态。",
						items: [
							{
								name: "镜像测速",
								desc: "查看各镜像源当前的连通与延迟。",
								render: (setting) => this._renderProbeControlRow(setting),
							},
							...MIRRORS.map((mirror, index) => ({
								name: mirror.label,
								render: (setting: Setting) =>
									this._renderMirrorRow(setting, index),
							})),
						],
					},
				],
			},
		];
	}

	/** 顶部高频入口：一键打开插件安装器界面。 */
	private _renderOpenRow(setting: Setting): void {
		setting
			.setName("打开插件界面")
			.setDesc("搜索并安装社区插件与主题。")
			.addButton((button) => {
				button
					.setButtonText("打开")
					.setCta()
					.onClick(() => {
						// 桌面设置是 modal、手机是满屏 pane：不收走设置，openView
						// 的激活全被遮挡（用户感知"没反应"）。先收设置再开面板，
						// 让跳转意图当场可见；本行在设置页首位，想回来重开即可。
						// app.setting 未进公开 d.ts，窄声明接管（同 getActiveLeaf 惯例）。
						const settingsDialog = this.app as unknown as {
							setting: { close: () => void };
						};
						settingsDialog.setting.close();
						void this.plugin.openView();
					});
			});
	}

	/** 「重新测速」按钮行（点击测速目标总是 this._probeRows）。 */
	private _renderProbeControlRow(setting: Setting): void {
		setting
			.setName("镜像测速")
			.setDesc("查看各镜像源当前的连通与延迟。")
			.addButton((button) => {
				button
					.setButtonText("重新测速")
					.onClick(() => {
						void this._runHealthProbe(this._probeRows);
					});
			});
	}

	/**
	 * 单镜像状态行：按下标存句柄（重渲染刷新引用、不追加重复）；最后一行的
	 * 渲染同时触发自动测速。
	 */
	private _renderMirrorRow(setting: Setting, index: number): void {
		setting.setName(MIRRORS[index]?.label ?? "");
		this._probeRows[index] = setting;
		if (index === MIRRORS.length - 1 && !this._probeStarted) {
			this._probeStarted = true;
			void this._runHealthProbe(this._probeRows);
		}
	}

	private async _runHealthProbe(rows: Setting[]): Promise<void> {
		const seq = ++this._healthProbeSeq;
		for (const row of rows) {
			row.setDesc("测速中…");
		}
		const probes = await probeMirrorsHealth();
		if (seq !== this._healthProbeSeq) {
			return;
		}
		for (let i = 0; i < probes.length && i < rows.length; i++) {
			const probe = probes[i];
			rows[i].setDesc(probe.ms === null ? "不可用" : `延迟 ${probe.ms}ms`);
		}
	}

	/**
	 * 「下载」行：desc 内嵌 BRAT 深度链接，点击经 openExternal 交宿主协议
	 * 处理（webviewer 开启时 window.open 被拦入应用内浏览器，处理不了
	 * obsidian://，见 DECISIONS「外链打开策略」）；与主页空态官方社区链接
	 * 同款写法。声明式定义里的 desc 为同文纯文本，供设置搜索索引。
	 */
	private _renderDownloadRow(setting: Setting): void {
		setting
			.setName("下载")
			.setDesc("仅支持官方社区已上架的插件与主题。未上架的插件需用 ");
		const brat = setting.descEl.createEl("a", {
			text: "BRAT",
			href: BRAT_URL,
		});
		brat.addEventListener("click", (e) => {
			e.preventDefault();
			openExternal(BRAT_URL);
		});
		setting.descEl.append(" 下载。（我做了汉化，已被作者合并）");
	}

	/** 作者行：GitHub／小红书图标钮（EasySync 同型照抄）。 */
	private _renderAuthorRow(setting: Setting): void {
		setting
			.setClass("op-settings-about-contact-setting")
			.setName("作者")
			.setDesc("焦应行（Jiao Yingxing）");
		setting.addButton((button) => {
			configureAboutContactButton(button, {
				label: "GitHub",
				icon: "github",
				url: GITHUB_URL,
			});
		});
		setting.addButton((button) => {
			configureAboutContactButton(button, {
				label: "小红书",
				icon: "book-open",
				url: XIAOHONGSHU_URL,
				extraClassName:
					"op-settings-about-contact-button--xiaohongshu",
			});
		});
	}
}