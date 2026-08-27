import { App, ButtonComponent, PluginSettingTab, Setting } from "obsidian";

import type OpenplugPlugin from "./main";
import { probeMirrorsHealth } from "./mirror";

export class OpenplugSettingTab extends PluginSettingTab {
	plugin: OpenplugPlugin;

	constructor(app: App, plugin: OpenplugPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const notice = new Setting(containerEl).setName("使用须知");
		notice.descEl.addClass("openplug-notice");
		notice.descEl.createEl("p", {
			text:
				"OpenPlug 并非 Obsidian 官方插件市场，也不属于 Obsidian 官方提供的功能。本插件所列的全部插件与主题均通过第三方 GitHub 镜像站点获取，仅供方便国内网络环境下的下载与安装。",
		});
		const list = notice.descEl.createEl("ul");
		list.createEl("li", {
			text:
				"所有插件、主题及其更新内容均由各自原作者提供，OpenPlug 不对其中内容的完整性、时效性、安全性或适用性作任何明示或默示的担保。",
		});
		list.createEl("li", {
			text:
				"下载与安装即代表你已知悉并自行承担由此带来的全部风险（包括但不限于数据丢失、设备安全、隐私泄露等）。",
		});
		list.createEl("li", {
			text:
				"请务必根据自身需求审慎选择，并在安装前核对来源与权限。如有疑虑，建议前往插件官方仓库确认。",
		});
		notice.descEl.createEl("p", {
			text:
				"本插件仅为获取渠道的辅助工具，不对使用者因使用第三方插件而产生的任何后果承担责任。",
		});

		const health = new Setting(containerEl).setName("镜像测速");
		health.descEl.addClass("openplug-health");
		new ButtonComponent(health.descEl)
			.setButtonText("重新测速")
			.onClick(() => {
				void probe();
			});

		const listEl = health.descEl.createDiv({ cls: "openplug-health-list" });

		const probe = async (): Promise<void> => {
			listEl.empty();
			listEl.createSpan({ text: "测速中…", cls: "setting-item-description" });
			const probes = await probeMirrorsHealth();
			listEl.empty();
			for (const p of probes) {
				const row = listEl.createDiv({ cls: "openplug-health-row" });
				row.createSpan({ text: p.mirror.label, cls: "openplug-health-name" });
				row.createSpan({
					text: p.ms === null ? "不可用" : `延迟 ${p.ms}ms`,
					cls: "setting-item-description",
				});
			}
		};

		void probe();
	}
}
