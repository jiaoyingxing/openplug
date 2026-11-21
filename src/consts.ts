export const VIEW_TYPE_PICKER = "openplug-picker";
export const VIEW_TYPE_FORUM = "openplug-forum-view";
export const FORUM_BASE = "https://forum-zh.obsidian.md";
export const FORUM_TIMEOUT_MS = 15000;
/** 宿主默认 UA 会被论坛前的 Cloudflare 以高负载页拦截；用插件自身
 * 标识（不带浏览器伪装）即可正常访问 POST 授权端点（2026-11-20 实测）。 */
export const FORUM_USER_AGENT = "OpenPlug";
