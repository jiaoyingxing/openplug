declare module "electron" {
	export const shell: {
		openExternal: (url: string) => Promise<void>;
	};
}

/**
 * Obsidian 桌面渲染器注入 `window.require`；移动端没有该入口，但调用点
 * 被 `Platform.isMobile` 分支隔离。类型在调用点窄化，见 `util.openExternal`。
 * 见 DECISIONS「桌面限定 / 外部链接」。
 */