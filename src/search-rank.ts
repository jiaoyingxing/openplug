/**
 * 顶部搜索结果排序（2026-10-25 用户要求「轻量、自然、简单」）。
 *
 * 不做相关度模型、不请求接口、不发搜索词：只按「命中的是哪个字段」分档，
 * 同档再按名称长度、最后按名称本地化序，保证同一清单一查一序。
 * 纯函数、无 obsidian 依赖，行为钉见 scripts/search-rank-smoke.mjs。
 */

/** 命中档位：越小越硬；-1 表示没命中。入参均为小写（调用方归一化）。 */
export function searchHitRank(
	name: string,
	author: string,
	id: string,
	desc: string,
	q: string,
): number {
	if (name === q) {
		return 0;
	}
	if (name.startsWith(q)) {
		return 1;
	}
	if (name.includes(q)) {
		return 2;
	}
	if (author.includes(q)) {
		return 3;
	}
	if (id.includes(q)) {
		return 4;
	}
	if (desc.includes(q)) {
		return 5;
	}
	return -1;
}

/** 排序比较：档位 → 名称长度（更短的名词更纯）→ 名称本地化序（稳定兜底）。 */
export function compareSearchHit(
	a: { rank: number; name: string },
	b: { rank: number; name: string },
): number {
	return (
		a.rank - b.rank ||
		a.name.length - b.name.length ||
		a.name.localeCompare(b.name, "zh-CN")
	);
}

/** 直搜排序方式：与分类筛选的排序单选同一组口径（热门 / 最近更新 / 名称）。 */
export type SearchSort = "downloads" | "updated" | "name";

/**
 * 按选中排序方式重排一组结果（调用方分组传入，插件与主题不互相穿插）。
 * 热门 / 最近更新用官方元数据：缺数据的一律排最后；同值保持传入次序
 * （即相关度次序，Array#sort 稳定）。
 */
export function sortSearchHits<T extends { name: string }>(
	hits: T[],
	sort: SearchSort,
	statOf: (hit: T) => { downloads?: number; updated?: string },
): T[] {
	if (sort === "name") {
		return hits.slice().sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
	}
	if (sort === "downloads") {
		return hits
			.slice()
			.sort((a, b) => (statOf(b).downloads ?? -1) - (statOf(a).downloads ?? -1));
	}
	return hits.slice().sort((a, b) => {
		const ua = statOf(a).updated ?? "";
		const ub = statOf(b).updated ?? "";
		if (ua === ub) {
			return 0;
		}
		return ua < ub ? 1 : -1;
	});
}
