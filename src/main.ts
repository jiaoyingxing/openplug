import { Notice, Plugin, WorkspaceLeaf } from "obsidian";

import { VIEW_TYPE_PICKER } from "./consts";
import { OpenplugSettingTab } from "./setting";
import { OpenplugPickerView } from "./view";

const SHOW_PLUGIN_ACTION = "show-plugin";
const SHOW_THEME_ACTION = "show-theme";

type ProtocolCallback = (params: Record<string, string>) => void;

interface ProtocolRegistry {
	handlers: Map<string, ProtocolCallback>;
}

interface AppWithProtocol {
	workspace: {
		protocolHandler: ProtocolRegistry;
	};
}

export default class OpenplugPlugin extends Plugin {
	private originalHandlers: Map<string, ProtocolCallback | undefined> = new Map();
	private hijackHandlers: Map<string, ProtocolCallback> = new Map();

	async onload(): Promise<void> {
		this.registerView(
			VIEW_TYPE_PICKER,
			(leaf: WorkspaceLeaf) => new OpenplugPickerView(leaf),
		);
		this.addSettingTab(new OpenplugSettingTab(this.app, this));

		const registry = this.protocolRegistry();
		if (!registry) {
			new Notice("未找到协议注册表，本插件未生效");
			return;
		}

		this.hijackAction(registry, SHOW_PLUGIN_ACTION, (p) =>
			this.handleShowPlugin(p),
		);
		this.hijackAction(registry, SHOW_THEME_ACTION, (p) =>
			this.handleShowTheme(p),
		);

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

		new Notice("已接管 show-plugin / show-theme（OpenPlug）");
	}

	onunload(): void {
		const registry = this.protocolRegistry();
		if (!registry) {
			return;
		}
		for (const [action, hijack] of this.hijackHandlers) {
			if (registry.handlers.get(action) === hijack) {
				const original = this.originalHandlers.get(action);
				if (original) {
					registry.handlers.set(action, original);
				} else {
					registry.handlers.delete(action);
				}
			}
		}
	}

	private hijackAction(
		registry: ProtocolRegistry,
		action: string,
		handler: ProtocolCallback,
	): void {
		this.originalHandlers.set(action, registry.handlers.get(action));
		const hijack: ProtocolCallback = (params) => handler(params);
		this.hijackHandlers.set(action, hijack);
		registry.handlers.set(action, hijack);
	}

	private protocolRegistry(): ProtocolRegistry | null {
		const app = this.app as unknown as AppWithProtocol;
		return app.workspace?.protocolHandler?.handlers
			? app.workspace.protocolHandler
			: null;
	}

	private handleShowPlugin(params: Record<string, string>): void {
		const pluginId = params?.id ?? "";
		if (!pluginId) {
			new Notice("链接缺少插件 id");
			return;
		}
		new Notice(`已捕获插件请求：${params.id}（OpenPlug）`);
		void this.openPicker(pluginId, "plugin");
	}

	private handleShowTheme(params: Record<string, string>): void {
		const themeName = params?.name ?? "";
		if (!themeName) {
			new Notice("链接缺少主题 name");
			return;
		}
		new Notice(`已捕获主题请求：${themeName}（OpenPlug）`);
		void this.openPicker(themeName, "theme");
	}

	private async openView(): Promise<void> {
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
			void workspace.revealLeaf(leaf);
		}
	}

	private async openPicker(
		identifier: string,
		kind: "plugin" | "theme",
	): Promise<void> {
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
		void workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof OpenplugPickerView) {
			if (kind === "plugin") {
				void view.loadFor(identifier);
			} else {
				void view.loadTheme(identifier);
			}
		}
	}
}
