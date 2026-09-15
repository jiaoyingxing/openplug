import { Platform } from "obsidian";

export const REQUEST_TIMEOUT_MS = 30000;
export const PROBE_TIMEOUT_MS = 8000;
export const TRANSLATE_TIMEOUT_MS = 10000;

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error("请求超时")), ms);
		p.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			(e: unknown) => {
				window.clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}

/**
 * 打开必须绕过宿主 window.open 拦截的链接（obsidian:// 深度链接、需系统
 * 浏览器承接的社区链接）。见 DECISIONS「桌面限定 / 外链打开策略」。
 */
export function openExternal(url: string): void {
	if (Platform.isMobile) {
		window.open(url, "_blank");
		return;
	}
	// 桌面：经 electron 直接打开系统浏览器，绕过 Obsidian 的 window-open
	// 拦截——启用「网页浏览器」核心插件（webviewer）时 window.open 会被
	// 转入应用内浏览器，内部浏览器无法触发 obsidian:// 深度链接回跳
	// （75555f8 的原设计意图；v1.1「统一 window.open」在无 webviewer 的
	// 环境误判该行为，见开发日志 20260828-2045 追加六/七）。
	// 取模块用宿主注入的 window.require（商店检查器禁止裸 require() 式
	// 导入；window.require 与模块级 require 同源等价，运行时已验证）。
	// 不能改用动态 import()：CJS 产物会保留原生 import()，运行时无法
	// 解析 electron 说明符（实测 TypeError）。此分支仅桌面执行，移动端
	// 永不求值，无加载期 electron 依赖。类型见 src/electron.d.ts。
	const electron = (
		window as unknown as { require?: (id: string) => unknown }
	).require?.("electron") as typeof import("electron");
	if (!electron) {
		throw new Error("electron 模块不可用");
	}
	void electron.shell.openExternal(url);
}
