import { App, Modal, requestUrl } from "obsidian";

import {
	FORUM_BASE,
	FORUM_TIMEOUT_MS,
	FORUM_USER_AGENT,
} from "./consts";
import { openExternal, withTimeout } from "./util";

const AUTH_SECRET_ID = "openplug-forum-auth";
/** 身份读取失败/未回名时的通用账号名（同 Module 内多处兜底共用一份）。 */
const DEFAULT_ACCOUNT_NAME = "论坛账号";
const POLL_INTERVAL_MS = 5000;
const CODE_PENDING_TEXT = "正在准备…";
const RETRY_TEXT = "重试中…";
const BUSY_TEXT = "论坛繁忙，请重试。";

export interface ForumAuthSession {
	key: string;
	clientId: string;
	username: string;
	name?: string;
}

interface DeviceAuthResponse {
	device_code?: string;
	user_code?: string;
	verification_uri?: string;
	verification_uri_with_request?: string;
	interval?: number;
}

interface PollResponse {
	status?: string;
	payload?: string;
}

interface SessionPayload {
	key?: string;
	nonce?: string;
	api?: number;
}

interface CurrentUserResponse {
	current_user?: {
		username?: string;
		name?: string;
	};
}

interface ForumIdentity {
	username: string;
	name: string;
}

export function loadForumAuth(app: App): ForumAuthSession | null {
	try {
		const raw = app.secretStorage.getSecret(AUTH_SECRET_ID);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as Partial<ForumAuthSession>;
		if (typeof parsed.key !== "string" || !parsed.key) {
			return null;
		}
		return {
			key: parsed.key,
			clientId:
				typeof parsed.clientId === "string" ? parsed.clientId : "",
			username:
				typeof parsed.username === "string" && parsed.username
					? parsed.username
					: DEFAULT_ACCOUNT_NAME,
			name:
				typeof parsed.name === "string" && parsed.name
					? parsed.name
					: undefined,
		};
	} catch {
		return null;
	}
}

export function saveForumAuth(app: App, session: ForumAuthSession): void {
	app.secretStorage.setSecret(AUTH_SECRET_ID, JSON.stringify(session));
}

export function clearForumAuth(app: App): void {
	app.secretStorage.setSecret(AUTH_SECRET_ID, "");
}

function randomHex(bytes: number): string {
	const values = crypto.getRandomValues(new Uint8Array(bytes));
	return Array.from(values, (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");
}

function toBase64(buffer: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(buffer)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function parseJson<T>(text: string | undefined): T | null {
	if (!text) {
		return null;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

function errorText(error: unknown): string {
	if (error instanceof Error && error.message) {
		if (error.message.includes("超时")) {
			return "网络超时，请重试。";
		}
		if (error.message.length <= 24) {
			return error.message;
		}
	}
	return "授权失败，请重试。";
}

/** 设备授权：插件生成配对码，用户在论坛点同意，插件轮询拿回
 * `User-Api-Key` 并存入宿主的 SecretStorage。论坛只认这把可撤销的
 * 钥匙，插件不接触账号密码（2026-11-20 实测链路）。 */
export class ForumAuthModal extends Modal {
	private _privateKey: CryptoKey | null = null;
	private _nonce = "";
	private _clientId = "";
	private _deviceCode = "";
	private _verificationUrl = "";
	private _csrfToken = "";
	private _pollTimer: number | null = null;
	private _pollIntervalMs = POLL_INTERVAL_MS;
	private _pollFailures = 0;
	private _pollingActive = false;
	private _closed = false;
	private _busy = false;
	private _codeEl: HTMLElement | null = null;
	private _statusRowEl: HTMLElement | null = null;
	private _statusEl: HTMLElement | null = null;
	private _spinnerEl: HTMLElement | null = null;
	private _actionBtn: HTMLButtonElement | null = null;
	private _actionMode: "open" | "retry" = "open";

	constructor(
		app: App,
		private readonly _onSuccess: (session: ForumAuthSession) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this._closed = false;
		this.modalEl.addClass("op-forum-auth-modal");
		this.titleEl.setText("登录论坛");
		this.contentEl.empty();
		this._codeEl = this.contentEl.createDiv({
			cls: "op-forum-auth-code",
			text: CODE_PENDING_TEXT,
		});
		this._codeEl.hidden = true;
		const actions = this.contentEl.createDiv({
			cls: "op-forum-auth-actions",
		});
		this._actionBtn = actions.createEl("button", {
			text: "准备中…",
			cls: "mod-cta",
		});
		this._actionBtn.disabled = true;
		this._actionBtn.addEventListener("click", () => this._onAction());

		this._statusRowEl = this.contentEl.createDiv({
			cls: "op-forum-auth-status",
		});
		this._statusRowEl.hidden = true;
		this._spinnerEl = this._statusRowEl.createDiv({
			cls: "op-forum-spinner",
		});
		this._statusEl = this._statusRowEl.createSpan();
		void this._start();
	}

	onClose(): void {
		this._closed = true;
		this._stopPolling();
		this._privateKey = null;
		this.contentEl.empty();
	}

	private async _start(): Promise<void> {
		if (this._closed || this._busy) {
			return;
		}
		this._busy = true;
		this._stopPolling();
		this._deviceCode = "";
		this._verificationUrl = "";
		this._csrfToken = "";
		this._pollFailures = 0;
		this._actionMode = "open";
		if (this._actionBtn) {
			this._actionBtn.setText("准备中…");
			this._actionBtn.disabled = true;
		}
		this._hideStatus();
		if (this._codeEl) {
			this._codeEl.setText(CODE_PENDING_TEXT);
			this._codeEl.hidden = true;
		}
		try {
			const keyPair = await crypto.subtle.generateKey(
				{
					name: "RSA-OAEP",
					modulusLength: 2048,
					publicExponent: new Uint8Array([1, 0, 1]),
					hash: "SHA-1",
				},
				true,
				["encrypt", "decrypt"],
			);
			this._privateKey = keyPair.privateKey;
			this._nonce = randomHex(16);
			this._clientId = `openplug-${randomHex(12)}`;
			const publicKey = await this._exportPublicKey(keyPair.publicKey);
			const csrf = await this._ensureCsrfToken();
			const response = await withTimeout(
				requestUrl({
					url: `${FORUM_BASE}/user-api-key/device`,
					method: "POST",
					contentType: "application/json",
					body: JSON.stringify({
						application_name: "OpenPlug",
						client_id: this._clientId,
						scopes: "read,write",
						public_key: publicKey,
						nonce: this._nonce,
						padding: "oaep",
					}),
					headers: {
						Accept: "application/json",
						"X-CSRF-Token": csrf,
						"User-Agent": FORUM_USER_AGENT,
					},
					throw: false,
				}),
				FORUM_TIMEOUT_MS,
			);
			if (response.status >= 300) {
				throw new Error(this._httpError(response.status));
			}
			if (this._closed) {
				return;
			}
			const data = parseJson<DeviceAuthResponse>(response.text);
			if (!data?.device_code || !data.user_code) {
				throw new Error(this._httpError(response.status));
			}
			this._deviceCode = data.device_code;
			this._verificationUrl =
				data.verification_uri_with_request ??
				data.verification_uri ??
				`${FORUM_BASE}/user-api-key/activate`;
			this._pollIntervalMs =
				typeof data.interval === "number" && data.interval > 0
					? data.interval * 1000
					: POLL_INTERVAL_MS;
			if (this._codeEl) {
				this._codeEl.setText(data.user_code);
				this._codeEl.hidden = false;
			}
			this._actionMode = "open";
			if (this._actionBtn) {
				this._actionBtn.setText("打开论坛授权");
				this._actionBtn.disabled = false;
			}
		} catch (error) {
			this._fail(errorText(error));
		} finally {
			this._busy = false;
		}
	}

	private _schedulePoll(): void {
		this._clearPollTimer();
		this._pollTimer = window.setTimeout(() => {
			this._pollTimer = null;
			void this._poll();
		}, this._pollIntervalMs);
	}

	private _clearPollTimer(): void {
		if (this._pollTimer !== null) {
			window.clearTimeout(this._pollTimer);
			this._pollTimer = null;
		}
	}

	private async _poll(): Promise<void> {
		if (this._closed || !this._deviceCode) {
			return;
		}
		try {
			const csrf =
				this._csrfToken || (await this._ensureCsrfToken());
			const response = await withTimeout(
				requestUrl({
					url: `${FORUM_BASE}/user-api-key/device/poll`,
					method: "POST",
					contentType: "application/json",
					body: JSON.stringify({ device_code: this._deviceCode }),
					headers: {
						Accept: "application/json",
						"X-CSRF-Token": csrf,
						"User-Agent": FORUM_USER_AGENT,
					},
					throw: false,
				}),
				FORUM_TIMEOUT_MS,
			);
			if (this._closed) {
				return;
			}
			if (response.status === 403) {
				this._csrfToken = "";
				this._retryPoll(RETRY_TEXT);
				return;
			}
			if (response.status >= 500 || response.status === 429) {
				this._retryPoll(RETRY_TEXT);
				return;
			}
			if (response.status >= 300) {
				throw new Error(this._httpError(response.status));
			}
			const data = parseJson<PollResponse>(response.text);
			if (!data) {
				this._retryPoll(RETRY_TEXT);
				return;
			}
			this._pollFailures = 0;
			if (data.status === "authorization_pending") {
				this._schedulePoll();
				return;
			}
			if (data.status === "authorized" && data.payload) {
				await this._complete(data.payload);
				return;
			}
			if (data.status === "access_denied") {
				this._fail("授权被拒绝，可重试。");
				return;
			}
			this._fail("授权已过期，请重试。");
		} catch (error) {
			this._fail(errorText(error));
		}
	}

	private _retryPoll(message: string): void {
		this._pollFailures += 1;
		if (this._pollFailures > 8) {
			this._fail(BUSY_TEXT);
			return;
		}
		this._setStatus(message, true, false);
		this._schedulePoll();
	}

	private async _complete(payload: string): Promise<void> {
		if (!this._privateKey) {
			this._fail("授权信息已丢失，请重试。");
			return;
		}
		try {
			const plain = await crypto.subtle.decrypt(
				{ name: "RSA-OAEP" },
				this._privateKey,
				fromBase64(payload),
			);
			const parsed = JSON.parse(
				new TextDecoder().decode(plain),
			) as SessionPayload;
			if (parsed.nonce !== this._nonce || !parsed.key) {
				throw new Error("授权校验失败，请重试。");
			}
			if (this._closed) {
				return;
			}
			const identity = await this._fetchIdentity(parsed.key);
			if (this._closed) {
				return;
			}
			const session: ForumAuthSession = {
				key: parsed.key,
				clientId: this._clientId,
				username: identity.username,
				name: identity.name,
			};
			saveForumAuth(this.app, session);
			this._stopPolling();
			this.close();
			this._onSuccess(session);
		} catch (error) {
			this._fail(errorText(error));
		}
	}

	private async _fetchIdentity(key: string): Promise<ForumIdentity> {
		try {
			const response = await withTimeout(
				requestUrl({
					url: `${FORUM_BASE}/session/current.json`,
					headers: {
						Accept: "application/json",
						"User-Api-Key": key,
						"User-Api-Client-Id": this._clientId,
						"User-Agent": FORUM_USER_AGENT,
					},
					throw: false,
				}),
				FORUM_TIMEOUT_MS,
			);
			if (response.status === 200) {
				const data = parseJson<CurrentUserResponse>(
					response.text,
				);
				const user = data?.current_user;
				if (user?.username) {
					return {
						username: user.username,
						name: user.name || user.username,
					};
				}
			}
		} catch {
			// 身份读取失败不阻塞授权：保留通用名称，写操作再做校验。
		}
		return { username: DEFAULT_ACCOUNT_NAME, name: DEFAULT_ACCOUNT_NAME };
	}

	private _onAction(): void {
		if (this._actionMode === "retry") {
			void this._start();
			return;
		}
		this._openBrowser();
	}

	private _openBrowser(): void {
		if (!this._verificationUrl) {
			return;
		}
		try {
			openExternal(this._verificationUrl);
			this._setStatus("等待确认…", true, false);
			this._actionBtn?.setText("重新打开");
			if (!this._pollingActive) {
				this._pollingActive = true;
				this._schedulePoll();
			}
		} catch (error) {
			this._fail(errorText(error));
		}
	}

	private async _exportPublicKey(key: CryptoKey): Promise<string> {
		const spki = await crypto.subtle.exportKey("spki", key);
		const body = toBase64(spki).match(/.{1,64}/g)?.join("\n") ?? "";
		return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
	}

	private _setStatus(
		text: string,
		spinner: boolean,
		error: boolean,
	): void {
		this._statusEl?.setText(text);
		if (this._statusEl) {
			this._statusEl.toggleClass("is-error", error);
		}
		if (this._statusRowEl) {
			this._statusRowEl.hidden = false;
		}
		if (this._spinnerEl) {
			this._spinnerEl.hidden = !spinner;
		}
	}

	private _hideStatus(): void {
		if (this._statusRowEl) {
			this._statusRowEl.hidden = true;
		}
	}

	private _fail(message: string): void {
		this._stopPolling();
		this._actionMode = "retry";
		if (this._actionBtn) {
			this._actionBtn.setText("重试");
			this._actionBtn.disabled = false;
		}
		this._setStatus(message, false, true);
	}

	private _stopPolling(): void {
		this._pollingActive = false;
		this._clearPollTimer();
	}

	private async _ensureCsrfToken(): Promise<string> {
		if (this._csrfToken) {
			return this._csrfToken;
		}
		const response = await withTimeout(
			requestUrl({
				url: `${FORUM_BASE}/session/csrf`,
				headers: {
					Accept: "application/json",
					"User-Agent": FORUM_USER_AGENT,
				},
				throw: false,
			}),
			FORUM_TIMEOUT_MS,
		);
		if (response.status >= 300) {
			throw new Error(this._httpError(response.status));
		}
		const token = parseJson<{ csrf?: string }>(
			response.text,
		)?.csrf;
		if (!token) {
			throw new Error("无法获取论坛安全令牌，请稍后重试。");
		}
		this._csrfToken = token;
		return token;
	}

	private _httpError(status: number): string {
		if (status === 403) {
			return "论坛拒绝请求，请重试。";
		}
		if (status === 429) {
			return "操作太频繁，请重试。";
		}
		if (status >= 500) {
			return BUSY_TEXT;
		}
		return "授权请求失败，请重试。";
	}
}
