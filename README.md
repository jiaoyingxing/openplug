# OpenPlug —— 不开 VPN 的插件自由

> **简体中文** · [English](./README-en.md)

<p align="center">
  <a href="https://github.com/jiaoyingxing/openplug/releases">
    <img alt="Release downloads" src="https://img.shields.io/github/downloads/jiaoyingxing/openplug/total.svg?style=flat-square&label=Release%20downloads" />
  </a>
  <a href="https://github.com/jiaoyingxing/openplug/releases">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/jiaoyingxing/openplug?style=flat-square&label=Latest%20release" />
  </a>
  <a href="./README.md">
    <img alt="CN 中文版" src="https://img.shields.io/badge/CN-%E4%B8%AD%E6%96%87%E7%89%88-d32f2f?style=flat-square" />
  </a>
  <a href="./README-en.md">
    <img alt="EN English" src="https://img.shields.io/badge/EN-English-2f6fed?style=flat-square" />
  </a>
</p>

OpenPlug lets users without a VPN install official Obsidian community plugins and themes with one click: click “Add to Obsidian” on the community directory and OpenPlug handles the download, verification, and installation through accelerated domestic GitHub mirrors. Full English version: [README-en.md](./README-en.md).

OpenPlug 让没有 VPN 的用户也能一键安装 Obsidian 官方社区插件和主题：点击官方社区的 “Add to Obsidian”，OpenPlug 即经国内 GitHub 镜像加速完成下载、校验与安装。

## 安装

1. **官方社区商店（推荐）**：Obsidian → 设置 → 第三方插件 → 关闭安全模式 → 浏览社区插件 → 搜索 **OpenPlug** → 安装并启用。
2. **手动安装**：从 [GitHub Releases](https://github.com/jiaoyingxing/openplug/releases) 下载 `main.js`、`manifest.json`、`styles.css` 三个文件，放入 vault 下的 `.obsidian/plugins/openplug/` 目录（移动端为对应应用文件夹内的同一路径），重启 Obsidian 后在第三方插件列表中启用。也可用 BRAT 插件添加 `jiaoyingxing/openplug` 跟踪预发布版本。

## 使用方式

入口较多，任选其一：

1. **网页浏览时（推荐）**：[官方社区](https://community.obsidian.md/) 打开插件或主题详情页，点击 **Add to Obsidian**，浏览器唤起 Obsidian 后自动回到 OpenPlug 面板完成安装。
2. **侧边栏购物车图标**：电脑上点击左侧边栏的购物车图标；手机上从屏幕左边缘向右滑出侧边栏，点击同样的图标。
3. **命令面板**：执行「打开插件 / 主题安装器」命令。
4. **插件设置页**：Obsidian → 设置 → 第三方插件 → OpenPlug，点击顶部「打开」按钮。

打开安装器后，在搜索框输入插件名、主题名或作者名，从结果中选择并安装。安装时会先展示插件信息卡（版本 / 作者 / ID / 兼容性）与简介译文，可自选安装版本；确认后一键下载、校验、安装并启用。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 协议接管安装 | 接管官网 `Add to Obsidian` 的跳转（插件与主题），在国内网络下完成原本连不上的安装链路 |
| 官方清单搜索 | 基于官方插件 / 主题清单，支持按名称、作者、ID 搜索，中文界面 |
| 信息卡与翻译 | 展示版本、作者、ID、兼容性；插件简介自动中英互译（失败时回退原文，不阻塞安装） |
| 版本自选 | 显示插件历史版本，默认安装最新版，也可回退指定版本 |
| 多镜像竞速加速 | 多个国内 GitHub 加速镜像并发竞速 + 30 秒超时 + 多镜像 SHA256 交叉校验，单个节点失效自动换源 |
| 主题安装 | 与插件相同的路径安装官方主题 |
| 电脑与手机 | Windows / macOS / Linux 与 iOS / Android 均可使用 |
| 镜像测速 | 设置页一键重新测速，直观了解各镜像当前延迟 |

## 网络使用与隐私披露

运行时只发起以下 HTTPS 请求，全部用于获取**公开**数据：

- 官方清单：`community-plugins.json` 与 `community-css-themes.json`（用于搜索与跳转解析）。
- 国内 GitHub 加速镜像（内置并经过实测验证）：`gh-proxy.com`、`ghfast.top`、`wget.la` —— 用于下载清单、manifest 与插件文件。
- jsDelivr 数据接口（`data.jsdelivr.com`）：获取插件历史版本列表。
- 翻译接口（仅发送**公开的插件描述文本**，用于侧栏简介的中英互译）：`uapis.cn`（主源）、`api.mymemory.translated.net`（兜底）。

不收集任何用户数据，无遥测，无广告，无账号要求。

## 使用须知与限制

- 本插件不是 Obsidian 官方功能，而是一个获取渠道的辅助工具；安装的插件 / 主题内容均由各自原作者提供，请自行核对来源与权限。
- 仅支持**官方社区已上架**的插件与主题；不在官方清单中的条目无法安装。
- 镜像节点为公益服务，可用性与速度会随网络环境波动；如遇全部节点不可用，可在设置页重新测速后重试。
- 软件著作权与许可：本插件以 [MIT License](./LICENSE) 开源；安装的第三方插件 / 主题遵循其各自的许可证。

## 兼容性

- 最低 Obsidian 版本：`1.7.2`。
- 桌面与移动端均支持（`isDesktopOnly: false`）。

## 开发

```powershell
npm run lint        # ESLint（obsidianmd 推荐规则）
npm run build       # 类型检查 + 生产构建（输出 dist/release）
```

源码使用 TypeScript，仅依赖 Obsidian API 与 Web API（`crypto.subtle` 做 SHA256 校验，不使用 Node API），产物由 esbuild 打包。

欢迎提交 Issue、PR 或参与翻译。LICENSE 见 [LICENSE](./LICENSE)。