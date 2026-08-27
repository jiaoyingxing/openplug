import { requestUrl } from "obsidian";

import { TRANSLATE_TIMEOUT_MS, withTimeout } from "./util";

interface Translator {
	id: string;
	translate(text: string): Promise<string>;
}

const translators: Translator[] = [
	{
		id: "uapis",
		translate: async (text: string) => {
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
	},
	{
		id: "mymemory",
		translate: async (text: string) => {
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
	},
];

export async function translateText(text: string): Promise<string | null> {
	if (!text.trim()) {
		return null;
	}
	for (const t of translators) {
		try {
			const result = await withTimeout(t.translate(text), TRANSLATE_TIMEOUT_MS);
			if (result) {
				return result;
			}
		} catch {
			// 尝试下一个翻译源
		}
	}
	return null;
}
