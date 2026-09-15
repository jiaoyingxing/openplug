import {
	App,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	SettingGroup,
} from "obsidian";

import type OpenplugPlugin from "./main";
import { MIRRORS, probeMirrorsHealth } from "./mirror";
import { openExternal } from "./util";

/** 作者 GitHub 仓库（与 README / Release 地址一致）。 */
const GITHUB_URL = "https://github.com/jiaoyingxing/openplug";
/** 作者小红书主页短链（与 Easy-Sync / Square 保持一致）。 */
const XIAOHONGSHU_URL = "https://xhslink.com/m/57v8xzlVMKp";
/** BRAT 在官方社区目录的详情页深度链接（由宿主协议接管打开）。 */
const BRAT_URL = "obsidian://show-plugin?id=obsidian42-brat";

/**
 * 设置页。Obsidian ≥1.13 走声明式 getSettingDefinitions（设置可被设置搜索
 * 索引；带按钮/动态内容的行以 render 回调命令式构建，与 display() 共用
 * 同一批行构建器）；<1.13 回落 display()（官方行为：getSettingDefinitions
 * 返回非空时 display() 不再被调用）。
 */
export class OpenplugSettingTab extends PluginSettingTab {
	plugin: OpenplugPlugin;

	/** 测速竞态序号：只让最后一次发起的测速写入结果，避免乱序覆盖。 */
	private healthProbeSeq = 0;
	/** 镜像状态行句柄（声明式/回落两条路径共用；重渲染时按下标刷新引用）。 */
	private probeRows: Setting[] = [];
	/** 自动测速触发标记：每次打开设置页重新武装，首渲染即启动一次。 */
	private probeStarted = false;

	constructor(app: App, plugin: OpenplugPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * 声明式设置定义（Obsidian ≥1.13）：静态信息行用 Empty 定义即可参与
	 * 设置搜索；带按钮或动态内容的行用 render 回调命令式构建（与 display()
	 * 同源实现）。此方法每次打开设置页与建立搜索索引时都会被调用。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		// 声明式路径下 display() 不被调用，容器作用域类在此补挂（幂等；
		// 与回落路径 display() 行为一致，见 20260828-1858 对齐惯例）。
		this.containerEl.addClass("openplug-settings-tab");
		// 重新武装自动测速：声明式路径在最后一镜像行渲染时触发（见
		// renderMirrorRow），与回落路径 display() 末尾触发行为一致。
		this.probeStarted = false;
		return [
			{
				name: "打开插件界面",
				desc: "搜索并安装社区插件与主题。",
				render: (setting) => this.renderOpenRow(setting),
			},
			{
				type: "group",
				heading: "关于",
				items: [
					{
						name: "产品",
						desc: `OpenPlug ${this.plugin.manifest.version?.trim() || ""}`,
					},
					{
						name: "作者",
						desc: "焦应行（Jiao Yingxing）。使用中遇到问题，可在 GitHub 提交 Issue，或通过小红书私信联系作者。",
						render: (setting) => this.renderAuthorRow(setting),
					},
				],
			},
			{
				type: "group",
				heading: "使用须知",
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
						render: (setting) => this.renderDownloadRow(setting),
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
				type: "group",
				// 无标题组：镜像测速为低频板块置页末，与回落路径轻分组同形态
				// （发布版设计，勿补 heading）。
				items: [
					{
						name: "镜像测速",
						desc: "查看各镜像源当前的连通与延迟。",
						render: (setting) => this.renderProbeControlRow(setting),
					},
					...MIRRORS.map((mirror, index) => ({
						name: mirror.label,
						render: (setting: Setting) =>
							this.renderMirrorRow(setting, index),
					})),
				],
			},
		];
	}

	/** <1.13 回落：命令式整页渲染（行构建与声明式共用同一批构建器）。 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("openplug-settings-tab");

		this.renderHomeGroup(containerEl);
		this.renderAboutGroup(containerEl);
		this.renderNoticeGroup(containerEl);
		this.renderHealthGroup(containerEl);
	}

	/** 顶部高频入口：一键打开插件安装器界面。 */
	private renderHomeGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl);
		group.addSetting((setting) => this.renderOpenRow(setting));
	}

	private renderOpenRow(setting: Setting): void {
		setting
			.setName("打开插件界面")
			.setDesc("搜索并安装社区插件与主题。")
			.addButton((button) => {
				button
					.setButtonText("打开")
					.setCta()
					.onClick(() => {
						void this.plugin.openView();
					});
			});
	}

	/**
	 * 镜像测速：无标题轻分组 + 每镜像一行的窄条目状态行。
	 * 低频板块，下沉到设置页末尾；测速结果就地回写各行的 desc，不整页重建
	 * （无跳顶、无闪烁；声明式模式下同样就地写回，不触发 update() 重渲染）。
	 */
	private renderHealthGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl);
		group.addSetting((setting) => this.renderProbeControlRow(setting));
		for (let index = 0; index < MIRRORS.length; index++) {
			group.addSetting((setting) =>
				this.renderMirrorRow(setting, index),
			);
		}
	}

	/** 「重新测速」按钮行（两条路径共用；点击测速目标总是 this.probeRows）。 */
	private renderProbeControlRow(setting: Setting): void {
		setting
			.setName("镜像测速")
			.setDesc("查看各镜像源当前的连通与延迟。")
			.addButton((button) => {
				button
					.setButtonText("重新测速")
					.onClick(() => {
						void this.runHealthProbe(this.probeRows);
					});
			});
	}

	/**
	 * 单镜像状态行：按下标存句柄（重渲染刷新引用、不追加重复）；最后一行的
	 * 渲染同时触发自动测速（回落路径的旧行为是 display() 末尾触发，等价）。
	 */
	private renderMirrorRow(setting: Setting, index: number): void {
		setting.setName(MIRRORS[index]?.label ?? "");
		this.probeRows[index] = setting;
		if (index === MIRRORS.length - 1 && !this.probeStarted) {
			this.probeStarted = true;
			void this.runHealthProbe(this.probeRows);
		}
	}

	private async runHealthProbe(rows: Setting[]): Promise<void> {
		const seq = ++this.healthProbeSeq;
		for (const row of rows) {
			row.setDesc("测速中…");
		}
		const probes = await probeMirrorsHealth();
		if (seq !== this.healthProbeSeq) {
			return;
		}
		for (let i = 0; i < probes.length && i < rows.length; i++) {
			const probe = probes[i];
			rows[i].setDesc(probe.ms === null ? "不可用" : `延迟 ${probe.ms}ms`);
		}
	}

	/** 使用须知：按用户定稿。 */
	private renderNoticeGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl).setHeading("使用须知");
		this.addReadOnlySetting(
			group,
			"隐私",
			"本插件开源，不收集你的数据，无遥测，无广告，不设账号。",
		);
		this.addReadOnlySetting(
			group,
			"来源",
			"所列的全部插件与主题均通过第三方 GitHub 镜像站点获取。",
		);
		group.addSetting((setting) => this.renderDownloadRow(setting));
		this.addReadOnlySetting(
			group,
			"风险提示",
			"插件上架前虽然会有官方自动审核，但多数插件为个人开发者维护，无法确保质量。建议优先选用下载量大、长期稳定维护的插件。",
		);
		this.addReadOnlySetting(
			group,
			"免责声明",
			"下载与安装即代表你已知悉并自行承担由此带来的全部风险（包括但不限于数据丢失、设备安全、隐私泄露等）。",
		);
	}

	/**
	 * 「下载」行：desc 内嵌 BRAT 深度链接，点击经 openExternal 交宿主协议
	 * 处理（webviewer 开启时 window.open 被拦入应用内浏览器，处理不了
	 * obsidian://，见 DECISIONS「外链打开策略」）；与主页空态官方社区链接
	 * 同款写法。声明式定义里的 desc 为同文纯文本，供设置搜索索引。
	 */
	private renderDownloadRow(setting: Setting): void {
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

	/** 关于：与 Sidet / Square 同构的窄条目信息行。 */
	private renderAboutGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl).setHeading("关于");
		this.addReadOnlySetting(
			group,
			"产品",
			`OpenPlug ${this.plugin.manifest.version?.trim() || ""}`,
		);
		group.addSetting((setting) => this.renderAuthorRow(setting));
	}

	private renderAuthorRow(setting: Setting): void {
		setting
			.setName("作者")
			.setDesc(
				"焦应行（Jiao Yingxing）。使用中遇到问题，可在 GitHub 提交 Issue，或通过小红书私信联系作者。",
			)
			.addButton((button) => {
				button
					.setButtonText("GitHub")
					.onClick(() => {
						window.open(GITHUB_URL, "_blank", "noopener,noreferrer");
					});
			})
			.addButton((button) => {
				button
					.setButtonText("小红书")
					.onClick(() => {
						window.open(
							XIAOHONGSHU_URL,
							"_blank",
							"noopener,noreferrer",
						);
					});
			});
	}

	private addReadOnlySetting(
		group: SettingGroup,
		name: string,
		description: string,
	): void {
		group.addSetting((setting) => {
			setting.setName(name).setDesc(description);
		});
	}
}