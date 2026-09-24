/**
 * 签名短链的公共原语：token 签发 / 校验 / 编码。
 *
 * 为什么单独一层：需要「不带凭据取文件、把结果写回来」的**不止 ONLYOFFICE** —— drawio、
 * Photopea 这类跑在浏览器里的在线服务需求完全一样，将来都用同一套短链机制，共用一个
 * `SIGNING_SECRET`。所以这里只放与具体服务无关的东西；ONLYOFFICE 自己的扩展名映射、
 * 会话响应留在 onlyoffice.ts（本文件不知道 ONLYOFFICE 的存在）。
 *
 * 本步是纯搬运：token 格式、TTL、校验规则与之前**完全一致**，只是换了个位置。
 */

/** 短链方向：read 只能取文件，write 只能覆盖写回。 */
export type TokenMode = 'read' | 'write';

export type TokenPayload = {
	/** R2 key，不带前导斜杠 */
	path: string;
	mode: TokenMode;
	/** 过期时间（秒） */
	expires: number;
	/** 版本 key（编辑器用它判断要不要重新下载）：同一版本稳定、内容一变就变 */
	key: string;
	/** 文件名，用于 Content-Disposition 与调试 */
	title: string;
};

export async function mint_token(secret: string, payload: TokenPayload): Promise<string> {
	const body = base64url_encode(new TextEncoder().encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign('HMAC', await hmac_key(secret), new TextEncoder().encode(body));
	return `${body}.${base64url_encode(new Uint8Array(signature))}`;
}

/** 校验签名、方向与过期时间。签名比较交给 crypto.subtle.verify（恒定时间）。 */
export async function verify_token(secret: string, token: string, mode: TokenMode): Promise<TokenPayload | null> {
	const dot = token.lastIndexOf('.');
	if (dot <= 0) {
		return null;
	}
	const body = token.slice(0, dot);
	const signature = base64url_decode(token.slice(dot + 1));
	if (signature === null) {
		return null;
	}
	const valid = await crypto.subtle.verify('HMAC', await hmac_key(secret), signature, new TextEncoder().encode(body));
	if (!valid) {
		return null;
	}

	const raw = base64url_decode(body);
	if (raw === null) {
		return null;
	}
	let payload: TokenPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(raw)) as TokenPayload;
	} catch {
		return null;
	}
	if (payload.mode !== mode) return null;
	if (typeof payload.expires !== 'number' || payload.expires * 1000 <= Date.now()) return null;
	if (typeof payload.path !== 'string' || payload.path === '') return null;
	return payload;
}

/**
 * CryptoKey 缓存。
 *
 * 同一 isolate 内会反复用到同一把密钥，而 importKey 是异步的、每次请求都做一遍纯属浪费。
 * 按 secret 缓存 promise，重复请求直接复用。
 */
const key_cache = new Map<string, Promise<CryptoKey>>();

function hmac_key(secret: string): Promise<CryptoKey> {
	let cached = key_cache.get(secret);
	if (cached === undefined) {
		cached = crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign', 'verify'],
		);
		key_cache.set(secret, cached);
	}
	return cached;
}

export function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64url_encode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64url_decode(value: string): Uint8Array | null {
	try {
		const padded = value.replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

export function json_response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}
