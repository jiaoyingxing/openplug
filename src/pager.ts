/**
 * 列表翻页条：上一页 / 第 X / Y 页 / 下一页。
 *
 * 只负责呈现与按钮状态（页码文本、首尾禁用、只有一页时整条隐藏）；页码、
 * 数据切片与翻页后的刷新由调用方持有——商店是服务端分页（翻页重新请求，
 * 带请求竞态与错误态），主页「插件更新」是本地切片（翻页不重新检查），
 * 失败与恢复路径不同，不合并状态机。
 */
export interface PagerHandle {
	/** 落笔当前页；只有一页时整条隐藏。 */
	setPage(page: number, pages: number): void;
	/** 隐藏翻页条（加载中、错误态、结果清空时调用）。 */
	hide(): void;
}

export function createPager(
	parent: HTMLElement,
	onPrev: () => void,
	onNext: () => void,
): PagerHandle {
	const el = parent.createDiv({ cls: "openplug-pager is-hidden" });
	const prev = el.createEl("button", {
		cls: "openplug-pager-btn",
		text: "上一页",
	});
	const info = el.createSpan({ cls: "openplug-pager-info" });
	const next = el.createEl("button", {
		cls: "openplug-pager-btn",
		text: "下一页",
	});
	prev.addEventListener("click", onPrev);
	next.addEventListener("click", onNext);
	return {
		setPage(page, pages) {
			if (pages <= 1) {
				el.addClass("is-hidden");
				return;
			}
			el.removeClass("is-hidden");
			info.setText(`第 ${page} / ${pages} 页`);
			prev.disabled = page <= 1;
			next.disabled = page >= pages;
		},
		hide() {
			el.addClass("is-hidden");
		},
	};
}
