/**
 * 结构化日志：每条记录自带时间戳与序号，字段是 JSON 对象而不是拼好的字符串。
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
