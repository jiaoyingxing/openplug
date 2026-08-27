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
