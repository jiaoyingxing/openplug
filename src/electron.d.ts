declare module "electron" {
	export const shell: {
		openExternal: (url: string) => Promise<void>;
	};
}

/**
 * Obsidian 桌面插件的 CJS 产物由宿主（Electron 渲染器）加载，`require`
 * 为宿主注入的模块加载器（`@types/node` v22 起不再提供全局 `require`
 * 声明）；移动端没有该全局，但调用点被 `Platform.isMobile` 分支隔离。
 * 见 DECISIONS「桌面限定 / 外部链接」。
 */
declare const require: (id: string) => unknown;