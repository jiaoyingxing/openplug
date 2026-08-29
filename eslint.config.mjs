import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
			// 桌面宿主（Electron 渲染器，CJS 产物加载）注入 require；
			// 移动端无该全局，但调用点被 Platform.isMobile 分支隔离
			// （类型声明见 src/electron.d.ts）。
			globals: { require: "readonly" },
		},
		rules: {
			"obsidianmd/ui/sentence-case": "off",
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
			// require("electron")：Obsidian 桌面只经 electron shell 才能强制
			// 打开系统浏览器（window.open 会被「网页浏览器」核心插件拦截转入
			// 应用内浏览器）；仅桌面分支求值，移动端无加载期依赖。
			"@typescript-eslint/no-require-imports": ["error", { allow: ["electron"] }],
		},
	},
]);
