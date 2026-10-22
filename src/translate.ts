import { requestUrl } from "obsidian";

import { TRANSLATE_TIMEOUT_MS, withTimeout } from "./util";

/** 按顺序兜底的翻译源：主源在前，失败依次降级。 */
const translators: Array<(text: string) => Promise<string>> = [
	async (text: string) => {
		const res = await requestUrl({
			url: "https://uapis.cn/api/v1/translate/text",
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ to_lang: "zh", text }),
		});
		if (res.status >= 300) {
			throw new Error(`HTTP ${res.status}`);
		}
		const data = res.json as { translate?: string };
		if (!data.translate || !data.translate.trim()) {
			throw new Error("空译文");
		}
		return data.translate.trim();
	},
	async (text: string) => {
		const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
			text,
		)}&langpair=en%7Czh-CN`;
		const res = await requestUrl({ url });
		if (res.status >= 300) {
			throw new Error(`HTTP ${res.status}`);
		}
		const data = res.json as {
			responseData?: { translatedText?: string };
		};
		const translated = data.responseData?.translatedText;
		if (!translated || !translated.trim()) {
			throw new Error("空译文");
		}
		if (/MYMEMORY WARNING/i.test(translated)) {
			throw new Error(translated);
		}
		return translated.trim();
	},
];

const CJK_CHAR = /[\u3400-\u9fff]/;
const CJK_CHARS = /[\u3400-\u9fff]/g;
const LATIN_CHARS = /[A-Za-z]/g;

/** 中文为主（按汉字/拉丁字母占比 ≥20%）的简介不再送翻，避免接口改写或原样返回。 */
function isMostlyChinese(text: string): boolean {
	const cjk = text.match(CJK_CHARS)?.length ?? 0;
	if (cjk === 0) {
		return false;
	}
	const latin = text.match(LATIN_CHARS)?.length ?? 0;
	return cjk / Math.max(1, cjk + latin) >= 0.2;
}

/** 同文判定忽略大小写、空白与标点，兜住接口“原样返回但空格/标点不同”。 */
function normalizeTranslation(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, "")
		.replace(/[\p{P}\p{S}]/gu, "");
}

function isUsableTranslation(source: string, result: string): boolean {
	const translated = result.trim();
	if (!translated || !CJK_CHAR.test(translated)) {
		return false;
	}
	return normalizeTranslation(translated) !== normalizeTranslation(source);
}

async function translateText(text: string): Promise<string | null> {
	if (!text.trim() || isMostlyChinese(text)) {
		return null;
	}
	for (const translate of translators) {
		try {
			const result = await withTimeout(translate(text), TRANSLATE_TIMEOUT_MS);
			if (result && isUsableTranslation(text, result)) {
				return result;
			}
		} catch {
			// 尝试下一个翻译源
		}
	}
	return null;
}

/** 详情入口的成功译文缓存；列表/搜索已改用外置预置表，不再批量机翻。 */
const TRANSLATION_CACHE_LIMIT = 200;
const translationCache = new Map<string, string>();
const inFlightTranslations = new Map<string, Promise<string | null>>();

export function translateTextCached(text: string): Promise<string | null> {
	const key = text.trim();
	if (!key || isMostlyChinese(key)) {
		return Promise.resolve(null);
	}
	const cached = translationCache.get(key);
	if (cached !== undefined) {
		return Promise.resolve(cached);
	}
	const pending = inFlightTranslations.get(key);
	if (pending) {
		return pending;
	}
	const request = translateText(key)
		.then((result) => {
			if (result) {
				translationCache.set(key, result);
				if (translationCache.size > TRANSLATION_CACHE_LIMIT) {
					const oldest = translationCache.keys().next().value;
					if (oldest !== undefined) {
						translationCache.delete(oldest);
					}
				}
			}
			return result;
		})
		.finally(() => {
			inFlightTranslations.delete(key);
		});
	inFlightTranslations.set(key, request);
	return request;
}
