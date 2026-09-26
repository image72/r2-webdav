/**
 * 与具体服务无关的纯工具：HTTP 响应、URL/路径、base64、结构化日志。
 *
 * 只收「不依赖运行时绑定、不依赖业务模块」的实现 —— token 签发/校验在 signing.ts，
 * R2 访问在 r2.ts，各编辑器协议在 editors.ts。所有模块都可以依赖本文件，
 * 本文件不依赖任何业务模块。唯一的模块内状态是日志的 seq 计数与 sink（见下）。
 */

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** JSON 响应，no-store：这些端点要么带凭据语义要么带 token，一律不许被缓存。 */
export function json_response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}

// ---------------------------------------------------------------------------
// URL / 路径
// ---------------------------------------------------------------------------

/** 把 key 编码成合法的 href；与 r2.ts 的 decode_path 互逆，保证 href 能原样请求回来。 */
export function encode_path(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * 规范化用户传来的 path：这是「外部字符串 → R2 key」的信任边界，产出会进签名
 * token（签名保证不可篡改，签的是什么路径由这里决定），因此规则从严、只有一份：
 *
 * - 去掉前导斜杠与首尾空白
 * - 拒绝空串、目录（尾斜杠）、`..`、内部空段（`a//b`）
 * - 长度上限 900（R2 key 上限 1024，留出余量）
 *
 * 注意 URLSearchParams 已经把百分号编码解开了，这里拿到的是真实文件名。
 */
export function normalize_path(input: string | null): string | null {
	if (input === null) return null;
	const path = input.trim().replace(/^\/+/, '');
	if (path === '' || path.endsWith('/')) return null;
	const segments = path.split('/');
	if (segments.includes('..') || segments.includes('')) return null;
	if (path.length > 900) return null;
	return path;
}

/** 取扩展名（小写、不含点；无扩展名返回空串）。 */
export function extension_of(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * 对外基址：显式配置的 EMBED_BASE_URL 优先（反代/自定义域场景），否则就是本次
 * 请求的 origin。只用于「往编辑器发的 URL」；服务内部回环请求请继续用请求 origin。
 */
export function base_url(base: string | undefined, request: Request): string {
	return (base ?? new URL(request.url).origin).replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

/** 字节 → base64url（无 padding），token 的两段编码都用它。 */
export function base64url_encode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64 / base64url → 字节。两种字母表都收（对标准输入，`-_` 替换是 no-op），
 * 显式补齐缺失的 padding；不剥离空白字符。
 *
 * 输入非法时返回 null（atob 会 throw，这里接住）—— 状态码由调用方决定，
 * 修掉的是「PP 发来截断的 base64 → handler 冒泡 → 裸 500」。
 */
export function base64_to_bytes(value: string): Uint8Array | null {
	try {
		const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// 结构化日志
// ---------------------------------------------------------------------------

/**
 * 每条记录自带时间戳与序号，字段是 JSON 对象而不是拼好的字符串。
 *
 * 设计：
 * - **ts**（ISO8601 UTC，毫秒精度）与 **seq**（isolate 内单调递增）由模块**内置** ——
 *   调用方永不手动传时间；同一 isolate 内 `(ts, seq)` 唯一且可排序，跨 isolate 靠 ts 对齐。
 * - **fields 是结构化 JSON**：`log_warn('pp.save rejected', { reason: 'bad_base64' })`。
 *   文本插值是渲染层的事 —— 将来接 Sentry（event + extra）或 OTEL（attributes）时字段
 *   原样映射，不需要反向解析字符串。
 * - **sink 可替换**：默认 console 单行 JSON（`wrangler tail` / Dashboards → Logs 直接可看；
 *   `--format json` 下逐字段可查）。接 Sentry/OTEL 时 `set_log_sink(...)` 换出口，
 *   调用方零改动；sink 抛错会自动回落 console，绝不影响响应路径。
 *
 * 红线（与安全约定一致）：
 * - 绝不打印完整 token / Basic 凭据 / 文件字节 —— token 只过 `token_hint()`；
 * - 全部同步调用，无 await。
 *
 * 用法：
 *     npx wrangler tail r2-webdav --format pretty | grep '\[r2wd\]'
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 结构化字段：值原样进 JSON；含循环引用的对象会被安全降级为 "[unserializable]"。 */
export type LogFields = Record<string, unknown>;

/** 一条日志的完整记录 —— 这也是未来 Sentry / OTEL sink 的输入形状。 */
export type LogRecord = {
	/** ISO8601 UTC，毫秒精度，模块内置。 */
	ts: string;
	/** isolate 内单调递增序号，与 ts 一起保证同 isolate 内唯一、可排序。 */
	seq: number;
	level: LogLevel;
	/** 稳定的事件名（查询主键）：`<域>.<动作> [结果]`，如 `pp.save rejected`。 */
	event: string;
	/** 结构化字段；不要放凭据、完整 token、大体积数据。 */
	fields: LogFields;
};

export type LogSink = (record: LogRecord) => void;

// --- 模块状态 ---------------------------------------------------------------

let seq = 0;
/** null = 默认 console sink。 */
let sink: LogSink | null = null;

/** 替换日志出口（Sentry / OTEL exporter）；传 null 恢复默认 console。 */
export function set_log_sink(next: LogSink | null): void {
	sink = next;
}

/** token 只露签名尾段 12 位：每条 token 唯一可关联，且拼不回完整凭据。
 *  （不取前缀 —— 所有 token 的 base64 负载都以 `{"path":` 开头，前缀无区分度。） */
export function token_hint(token: string): string {
	return '…' + token.slice(-12);
}

// --- 默认 console sink -------------------------------------------------------

function safe_stringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return '"[unserializable]"';
	}
}

/** 单行 JSON：tail pretty 可 grep；tail --format json / 日志系统可逐字段解析。 */
function console_emit(record: LogRecord): void {
	const line = `[r2wd] ${safe_stringify(record)}`;
	if (record.level === 'error') console.error(line);
	else if (record.level === 'warn') console.warn(line);
	else console.log(line);
}

// --- emit 与级别 API ---------------------------------------------------------

function emit(level: LogLevel, event: string, fields?: LogFields): void {
	// ts/seq 模块内置：调用方不传时间，也不允许覆盖这些内部字段。
	const record: LogRecord = { ts: new Date().toISOString(), seq: ++seq, level, event, fields: fields ?? {} };
	try {
		(sink ?? console_emit)(record);
	} catch {
		// 自定义 sink 异常不许打断业务，回落默认 console。
		console_emit(record);
	}
}

export function log_debug(event: string, fields?: LogFields): void {
	emit('debug', event, fields);
}

export function log_info(event: string, fields?: LogFields): void {
	emit('info', event, fields);
}

/** 异常路径用 warn/error：tail pretty 模式会高亮，验收时一眼看到。 */
export function log_warn(event: string, fields?: LogFields): void {
	emit('warn', event, fields);
}

export function log_error(event: string, fields?: LogFields): void {
	emit('error', event, fields);
}
