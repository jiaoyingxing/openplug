/**
 * 冷启动缓存（IndexedDB）：官方清单与更新检查结果跨会话复用。
 *
 * localStorage 只承接小对象（预置翻译 22KB，同步读写）；官方插件清单是
 * 3MB 级 JSON（10,666 条），放 localStorage 会让主线程同步解析，故走
 * IndexedDB（真实宿主实测 2.9MB 写入 46ms / 读取 8ms）。
 *
 * 一切失败都静默降级为「无缓存」：库不可用（隐私模式 / 配额）、事务
 * 失败、结构不符都返回 null，调用方按原链路重新请求。缓存只是加速，
 * 任何情况下都不能挡住主功能。
 */
const DB_NAME = "openplug-cache";
const STORE_NAME = "kv";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** 库在但缺 objectStore 时（同名库由别处建过 / 库被外部删后又重建），
 * `open` 不会触发 upgrade，只能删库重开让它走一次 onupgradeneeded。 */
function deleteEmptyDb(factory: IDBFactory): Promise<void> {
	return new Promise((resolve) => {
		try {
			const request = factory.deleteDatabase(DB_NAME);
			request.onsuccess = () => resolve();
			request.onerror = () => resolve();
			request.onblocked = () => resolve();
		} catch {
			resolve();
		}
	});
}

function openOnce(factory: IDBFactory): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		try {
			const request = factory.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME);
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
			// blocked 本次按无缓存处理，句柄不缓存，下次调用再试
			request.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

async function openVerified(): Promise<IDBDatabase | null> {
	const factory = window.indexedDB;
	if (!factory) {
		return null;
	}
	const db = await openOnce(factory);
	if (!db) {
		return null;
	}
	if (db.objectStoreNames.contains(STORE_NAME)) {
		return db;
	}
	// 结构不对：关掉空壳、删库、重建一次。重建仍不对就放弃（按无缓存走）。
	db.close();
	await deleteEmptyDb(factory);
	const rebuilt = await openOnce(factory);
	if (rebuilt?.objectStoreNames.contains(STORE_NAME)) {
		return rebuilt;
	}
	rebuilt?.close();
	return null;
}

function openDb(): Promise<IDBDatabase | null> {
	if (!dbPromise) {
		dbPromise = openVerified().then((db) => {
			if (!db) {
				// 失败不缓存句柄：下次调用（如用户清完存储后）还能再试
				dbPromise = null;
				return null;
			}
			// 别的会话升级结构 / 库被外部删除时主动让位，下次读写重新打开
			db.onversionchange = () => {
				db.close();
				dbPromise = null;
			};
			db.onclose = () => {
				dbPromise = null;
			};
			return db;
		});
	}
	return dbPromise;
}

/** 结构失效（库被外部删/重建）时作废句柄，下次调用重建库与 objectStore。 */
function resetDb(): void {
	dbPromise = null;
}

/** 读缓存；无记录、库不可用或结构损坏一律返回 null。 */
export async function readLocalCache<T>(key: string): Promise<T | null> {
	const db = await openDb();
	if (!db) {
		return null;
	}
	return new Promise<T | null>((resolve) => {
		try {
			const request = db
				.transaction(STORE_NAME, "readonly")
				.objectStore(STORE_NAME)
				.get(key);
			request.onsuccess = () => {
				resolve((request.result as T | undefined) ?? null);
			};
			request.onerror = () => resolve(null);
		} catch {
			resetDb();
			resolve(null);
		}
	});
}

/** 写缓存（覆盖）；失败静默——缓存只是加速，不影响本次链路。 */
export async function writeLocalCache(
	key: string,
	value: unknown,
): Promise<void> {
	const db = await openDb();
	if (!db) {
		return;
	}
	await new Promise<void>((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, "readwrite");
			tx.objectStore(STORE_NAME).put(value, key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		} catch {
			resetDb();
			resolve();
		}
	});
}
