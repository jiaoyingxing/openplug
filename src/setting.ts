import { App, PluginSettingTab, Setting, SettingGroup } from "obsidian";

import type OpenplugPlugin from "./main";
import { MIRRORS, probeMirrorsHealth } from "./mirror";

/** 作者 GitHub 仓库（与 README / Release 地址一致）。 */
const GITHUB_URL = "https://github.com/jiaoyingxing/openplug";
/** 作者小红书主页短链（与 Easy-Sync / Square 保持一致）。 */
const XIAOHONGSHU_URL = "https://xhslink.com/m/57v8xzlVMKp";

export class OpenplugSettingTab extends PluginSettingTab {
	plugin: OpenplugPlugin;

	/** 测速竞态序号：只让最后一次发起的测速写入结果，避免乱序覆盖。 */
	private healthProbeSeq = 0;

	constructor(app: App, plugin: OpenplugPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

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

		group.addSetting((setting) => {
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
		});
	}

	/**
	 * 镜像测速：无标题轻分组 + 每镜像一行的窄条目状态行。
	 * 低频板块，下沉到设置页末尾；测速结果就地回写各行的 desc，不整页重建（无跳顶、无闪烁）。
	 */
	private renderHealthGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl);
		const rows: Setting[] = [];

		group.addSetting((setting) => {
			setting
				.setName("镜像测速")
				.setDesc("查看各镜像源当前的连通与延迟。")
				.addButton((button) => {
					button
						.setButtonText("重新测速")
						.onClick(() => {
							void this.runHealthProbe(rows);
						});
				});
		});

		for (const mirror of MIRRORS) {
			group.addSetting((setting) => {
				setting.setName(mirror.label);
				rows.push(setting);
			});
		}

		void this.runHealthProbe(rows);
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
		this.addReadOnlySetting(
			group,
			"下载",
			"仅支持官方社区已上架的插件与主题。",
		);
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

	/** 关于：与 Sidet / Square 同构的窄条目信息行。 */
	private renderAboutGroup(containerEl: HTMLElement): void {
		const group = new SettingGroup(containerEl).setHeading("关于");
		this.addReadOnlySetting(
			group,
			"产品",
			`OpenPlug ${this.plugin.manifest.version?.trim() || ""}`,
		);
		group.addSetting((setting) => {
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