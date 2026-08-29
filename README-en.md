# OpenPlug — One-Click Plugin Freedom Without a VPN

> [简体中文](./README.md) · **English**

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

OpenPlug lets users without a VPN install official Obsidian community plugins and themes with one click.

## Installation

1. **Community directory (recommended)**: Obsidian → Settings → Third-party plugins → turn off Safe mode → Browse community plugins → search **OpenPlug** → Install and enable.
2. **Manual installation**: download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/jiaoyingxing/openplug/releases), place them in `.obsidian/plugins/openplug/` inside your vault (the same path under the app data folder on mobile), restart Obsidian, and enable the plugin in the community plugins list. The BRAT plugin can also track prerelease builds from `jiaoyingxing/openplug`.

## How to use

### Opening the installer

Pick whichever is handy:

- **Toolbar icon**: click the shopping-cart icon — it sits in the left ribbon on desktop and in the bottom toolbar on mobile.
- **Command palette**: run “Open plugin / theme installer”.
- **Settings page**: Obsidian → Settings → Third-party plugins → OpenPlug, then click **Open** under “Open plugin interface”.
- **Community directory redirect (recommended)**: open a plugin or theme detail page on the [Obsidian Community Directory](https://community.obsidian.md/) and click **Add to Obsidian**; confirm the redirect in your browser and the installer opens automatically.

### Installing a plugin or theme

Type a plugin name, theme name, or author name in the search box and pick a result. Before installing, OpenPlug shows an info card (version / author / ID / compatibility) plus a translated description, and lets you pick a specific version. One click downloads, verifies, installs, and enables the item.

### Updating plugins

The installer home page automatically checks your installed official plugins for updates (stable versions only) and lists them one by one; click **Update** and restart Obsidian for the new version to take effect. Updates are always started by you, never automatic, and never change a plugin's enabled state.

## Features

| Feature | Description |
| --- | --- |
| Protocol interception | Captures the official `Add to Obsidian` redirect (plugins and themes) and completes the install chain under restricted networks |
| Official directory search | Searches the official plugin / theme list by name, author, or ID, with a Chinese UI |
| Info card & translation | Shows version, author, ID, and compatibility; auto-translates plugin descriptions into Chinese (falls back to the original text without blocking) |
| Version selection | Lists published versions and installs the latest by default; older versions can be picked |
| Multi-mirror acceleration | Races multiple domestic GitHub mirror nodes with a 30s timeout and SHA-256 cross-verification, auto-switching when a node fails |
| Theme installation | Installs official themes through the same flow |
| Desktop & mobile | Works on Windows / macOS / Linux and iOS / Android |
| Plugin update checks | The home page lists updatable installed official plugins (stable versions only); updates run one by one, are manual only, and keep each plugin's enabled state |
| Mirror latency test | One-click latency probe in settings for all built-in mirrors |

## Network usage & privacy disclosure

At runtime the plugin only makes the following HTTPS requests, all for **public** data:

- Official lists: `community-plugins.json` and `community-css-themes.json` (search and redirect resolution).
- Domestic GitHub acceleration mirrors (built-in and latency-verified): `gh-proxy.com`, `ghfast.top`, `wget.la` — used to download lists, manifests, and plugin files.
- jsDelivr data API (`data.jsdelivr.com`): plugin version lists (version picker and update checks).
- Translation APIs (only the **public plugin description text** is sent, for translating the sidebar description into Chinese): `uapis.cn` (primary), `api.mymemory.translated.net` (fallback).

No user data is collected. No telemetry, no ads, no account required. Update checks compare your installed plugins with the official list locally — no installation data is uploaded.

## Notes & limitations

- OpenPlug is not an official Obsidian feature — it is a helper for the installation channel only. Plugin / theme content is provided by their respective authors; verify source and permissions yourself.
- Only plugins and themes **already listed in the official community directory** are supported.
- Mirror nodes are free public services; availability and speed fluctuate with network conditions. If all nodes fail, re-run the latency test in settings and retry.
- Licensing: this plugin is open source under the [MIT License](./LICENSE). Third-party plugins / themes you install follow their own licenses.

## Compatibility

- Minimum Obsidian version: `1.11.4`.
- Desktop and mobile are both supported (`isDesktopOnly: false`).

## Development

```powershell
npm run lint          # ESLint (obsidianmd recommended rules)
npm run build         # typecheck + production build (output: dist/release)
```

The source is TypeScript and depends only on the Obsidian API and Web APIs (`crypto.subtle` for SHA-256 verification; no Node API). The bundle is produced with esbuild.

Issues, PRs, and translation contributions are welcome. License: [LICENSE](./LICENSE).