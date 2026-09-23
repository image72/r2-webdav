/**
 * R2 WebDAV Worker：WebDAV 协议实现（PROPFIND/PUT/COPY/…）。
 *
 * - 浏览器页面（列表/上传/预览）：ui.ts
 * - R2 访问工具：r2.ts
 * - Worker 入口、鉴权与路由：index.ts
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import {
	PERFORMANCE_CONFIG,
	decode_path,
	encode_path,
	is_os_metadata_key,
	listDir,
	listRecursive,
	processWithConcurrencyLimit,
} from './r2';
import { handle_browse_request } from './ui';

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
	supportedlock: string;
	lockdiscovery: string;
	ishidden: string;
	isreadonly: string;
};

function fromR2Object(object: R2Object | null | undefined): DavProperties {
	if (object === null || object === undefined) {
		return {
			creationdate: new Date().toUTCString(),
			displayname: undefined,
			getcontentlanguage: undefined,
			getcontentlength: '0',
			getcontenttype: undefined,
			getetag: undefined,
			getlastmodified: new Date().toUTCString(),
			resourcetype: '<collection />',
			supportedlock: '<lockentry><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockentry>',
			lockdiscovery: '',
			ishidden: '0',
			isreadonly: '0',
		};
	}

	return {
		creationdate: object.uploaded.toUTCString(),
		// 这些值会直接拼进 XML，必须转义：元数据里的 & 与 < 会让整个 multistatus
		// 变成非法 XML，所有客户端都解析不了。
		// displayname 是"给人看的资源名"（RFC 4918 §15.2），就应该是文件名本身。
		// 旧实现把 Content-Disposition 整体塞进来，客户端看到的是
		// `attachment; filename="x.txt"` 这种字符串。
		displayname: escape_xml(object.key.slice(object.key.lastIndexOf('/') + 1)),
		getcontentlanguage: object.httpMetadata?.contentLanguage
			? escape_xml(object.httpMetadata.contentLanguage)
			: undefined,
		getcontentlength: object.size.toString(),
		getcontenttype: object.httpMetadata?.contentType ? escape_xml(object.httpMetadata.contentType) : undefined,
		// 必须用 httpEtag：etag 不带引号，而 RFC 4918 要求 getetag 是带引号的实体标签
		getetag: escape_xml(object.httpEtag),
		getlastmodified: object.uploaded.toUTCString(),
		resourcetype: object.customMetadata?.resourcetype ?? '',
		supportedlock: '<lockentry><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockentry>',
		lockdiscovery: '',
		ishidden: '0',
		isreadonly: '0',
	};
}

function make_resource_path(request: Request): string {
	const path = new URL(request.url).pathname.slice(1);
	const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
	// 存进 R2 的必须是真实文件名，而不是客户端发来的百分号编码形式
	return decode_path(trimmed);
}

/** 去掉路径最后一段（父集合）；没有分隔符时返回空串，表示桶根。 */
function parent_path(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}

/** XML 元素内容转义。文件名里的 & 与 < 会让整个 multistatus 无法解析。 */
function escape_xml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 是否为集合（目录）。目录以 `customMetadata.resourcetype` 标记对象的形式存储。 */
function is_collection(object: R2Object): boolean {
	return object.customMetadata?.resourcetype === '<collection />';
}

/** 写入一个目录标记对象。 */
async function put_collection_marker(bucket: R2Bucket, path: string): Promise<void> {
	await bucket.put(path, new Uint8Array(), { customMetadata: { resourcetype: '<collection />' } });
}

/**
 * 判断路径是否存在，并给出它是否是集合。不存在时返回 null。
 *
 * 没有标记对象时会再用一次 list 探测是否有以它为前缀的对象：否则"隐式目录"
 * （由其它工具直接写入深层 key 造成）会被当成不存在 —— PROPFIND 回 404、
 * DELETE 回 404，而它的子对象其实一直存在。
 */
async function resource_exists(
	bucket: R2Bucket,
	path: string,
): Promise<{ object: R2Object | null; is_collection: boolean } | null> {
	const object = await bucket.head(path);
	if (object !== null) {
		return { object: object, is_collection: is_collection(object) };
	}
	if (path === '') {
		return null;
	}
	const probe = await bucket.list({ prefix: `${path}/`, limit: 1 });
	if (probe.objects.length > 0) {
		return { object: null, is_collection: true };
	}
	return null;
}

/**
 * 成员数超出一单次可安全处理的规模时拒绝，而不是只处理一部分。
 *
 * 旧实现会静默地把 COPY/MOVE 截断在 3000 个成员，却照常回 201：客户端以为整体
 * 成功，实际少了数据（MOVE 还会把剩下的留在源端变成不可见的孤儿）。507 是
 * WebDAV 里表示"服务器存量不足/无法完成"的标准状态码。
 */
function too_many_members(path: string): Response {
	return new Response(
		`Too many members under /${path} (limit ${PERFORMANCE_CONFIG.MAX_OBJECTS_PER_REQUEST}). ` +
			'Refusing to process only part of it so that nothing is silently lost; split the collection and retry.',
		{ status: 507 },
	);
}

/**
 * COPY/MOVE 的 Destination 解析。
 * 非法值 → 400；指向其它主机的 URL → 502（RFC 4918 §9.8.5：不支持跨服务器操作时如此响应），
 * 旧实现只取 pathname，会把外部主机的目标静默写进本桶。
 */
function resolve_destination(request: Request, header: string | null): string | Response {
	if (header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let url: URL;
	try {
		url = new URL(header);
	} catch {
		return new Response('Bad Request', { status: 400 });
	}
	if (url.host !== new URL(request.url).host) {
		return new Response('Bad Gateway', { status: 502 });
	}
	let path = url.pathname.slice(1);
	// Destination 同样是百分号编码的，必须解码后当 key 用
	return decode_path(path.endsWith('/') ? path.slice(0, -1) : path);
}

/** 实体标签比较：Weak 比较（忽略 W/ 前缀），`*` 表示"资源存在"。 */
function etag_matches(header_value: string, etag: string, exists: boolean): boolean {
	for (const candidate of header_value.split(',')) {
		const trimmed = candidate.trim();
		if (trimmed === '*') return exists;
		if (trimmed.replace(/^W\//, '') === etag.replace(/^W\//, '')) return true;
	}
	return false;
}

type ConditionalResult = 'proceed' | 'not-modified' | 'precondition-failed';

/**
 * RFC 9110 §13.2.2 的条件请求求值（按优先级：If-Match → If-Unmodified-Since →
 * If-None-Match → If-Modified-Since）。
 *
 * 自己算而不用 R2 的 onlyIf，有两个原因：R2 在条件不满足时只返回一个没有 body 的
 * 对象，无法区分 304 与 412；而 RFC 要求 GET/HEAD 的 If-None-Match / If-Modified-Since
 * 不满足时必须回 304 —— 旧实现在所有情况下都回 412，缓存校验类客户端因此永远拿不到 304。
 */
function evaluate_conditionals(request: Request, object: R2Object): ConditionalResult {
	const headers = request.headers;
	const etag = object.httpEtag;

	const if_match = headers.get('If-Match');
	if (if_match !== null && !etag_matches(if_match, etag, true)) {
		return 'precondition-failed';
	}

	const if_unmodified_since = headers.get('If-Unmodified-Since');
	if (if_unmodified_since !== null) {
		const limit = Date.parse(if_unmodified_since);
		if (!Number.isNaN(limit) && object.uploaded.getTime() > limit) {
			return 'precondition-failed';
		}
	}

	const if_none_match = headers.get('If-None-Match');
	if (if_none_match !== null) {
		return etag_matches(if_none_match, etag, true) ? 'not-modified' : 'proceed';
	}

	const if_modified_since = headers.get('If-Modified-Since');
	if (if_modified_since !== null) {
		const limit = Date.parse(if_modified_since);
		if (!Number.isNaN(limit) && object.uploaded.getTime() <= limit) {
			return 'not-modified';
		}
	}

	return 'proceed';
}

async function handle_head(request: Request, bucket: R2Bucket): Promise<Response> {
	let response = await handle_get(request, bucket);
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * 集合地址缺少尾斜杠时回 301，把客户端引到规范形式。
 *
 * RFC 4918 §5.1：集合用带尾斜杠的 URL 是规范形式；服务器可以把不带斜杠的请求当作带了，
 * 并应该用 Content-Location 指出规范 URL；同时明确说“客户端需要准备好看到重定向”。
 * 旧实现直接返回目录标记那个 0 字节对象，于是 GET /dir 得到 200 + 空体，客户端会以为
 * 那是个空文件（下载为空、编辑器打开空白），而不是目录。
 *
 * 查询串必须原样保留：`?format=json` 这类请求在重定向后还得是同一个语义。
 */
function redirect_to_collection(request: Request): Response {
	const url = new URL(request.url);
	return new Response(null, {
		status: 301,
		headers: { Location: `${url.pathname}/${url.search}` },
	});
}

async function handle_get(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	if (new URL(request.url).pathname.endsWith('/')) {
		// 目录请求全权交给页面层：?format=json 返回数据，其余返回 Alpine 页面
		return await handle_browse_request(request, bucket);
	}

	// 只传 range，条件交给 evaluate_conditionals 自己算：R2 的 onlyIf 在条件不满足时
	// 只返回一个没有 body 的对象，无法区分 304 与 412；而 RFC 9110 要求 GET/HEAD 的
	// If-None-Match / If-Modified-Since 不满足时必须回 304。
	const object = await bucket.get(resource_path, { range: request.headers });

	if (object === null) {
		// 没有标记对象的“隐式目录”（只有子对象、从未 MKCOL 过）也是个集合，同样要重定向
		if (resource_path !== '') {
			const probe = await bucket.list({ prefix: `${resource_path}/`, limit: 1 });
			if (probe.objects.length > 0) {
				return redirect_to_collection(request);
			}
		}
		return new Response('Not Found', { status: 404 });
	}

	// 目录：这里是那个 0 字节标记对象，不是真的文件内容 —— 重定向而不是当作空文件发出去
	if (is_collection(object)) {
		return redirect_to_collection(request);
	}

	const conditional = evaluate_conditionals(request, object);
	if (conditional !== 'proceed') {
		if ('body' in object) {
			await object.body.cancel(); // 命中缓存，没必要再把 body 读完
		}
		return new Response(null, {
			status: conditional === 'not-modified' ? 304 : 412,
			headers: { ETag: object.httpEtag, 'Last-Modified': object.uploaded.toUTCString() },
		});
	}

	if (!('body' in object)) {
		return new Response('Precondition Failed', { status: 412 });
	}

	const { rangeOffset, rangeEnd } = calcContentRange(object);
	const contentLength = rangeEnd - rangeOffset + 1;
	// 只有真的返回片段时才带 Content-Range：200 响应上带它是 RFC 9110 §15.3.7 明确禁止的，
	// 而且旧代码给空对象算出了 `bytes 0--1/0` 这种非法负区间。
	// 这里必须用长度比对而不是 `object.range !== undefined`：R2 在请求根本没带 Range 头时
	// 也会返回一个覆盖整个对象的 range，用它判断会让所有普通下载都变成 206 + Content-Range。
	const is_partial = contentLength !== object.size;
	return new Response(object.body, {
		status: is_partial ? 206 : 200,
		headers: {
			'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
			'Content-Length': contentLength.toString(),
			'Accept-Ranges': 'bytes',
			ETag: object.httpEtag,
			'Last-Modified': object.uploaded.toUTCString(),
			...(is_partial ? { 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` } : {}),
			...(object.httpMetadata?.contentDisposition
				? {
						'Content-Disposition': object.httpMetadata.contentDisposition,
					}
				: {}),
			...(object.httpMetadata?.contentEncoding
				? {
						'Content-Encoding': object.httpMetadata.contentEncoding,
					}
				: {}),
			...(object.httpMetadata?.contentLanguage
				? {
						'Content-Language': object.httpMetadata.contentLanguage,
					}
				: {}),
			...(object.httpMetadata?.cacheControl
				? {
						'Cache-Control': object.httpMetadata.cacheControl,
					}
				: {}),
			...(object.httpMetadata?.cacheExpiry
				? {
						'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
					}
				: {}),
		},
	});
}

function calcContentRange(object: R2ObjectBody) {
	let rangeOffset = 0;
	let rangeEnd = object.size - 1;
	if (object.range) {
		if ('suffix' in object.range) {
			// Case 3: {suffix: number}
			rangeOffset = object.size - object.range.suffix;
		} else {
			// Case 1: {offset: number, length?: number}
			// Case 2: {offset?: number, length: number}
			rangeOffset = object.range.offset ?? 0;
			let length = object.range.length ?? object.size - rangeOffset;
			rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
		}
	}
	return { rangeOffset, rangeEnd };
}

async function handle_put(request: Request, bucket: R2Bucket): Promise<Response> {
	if (request.url.endsWith('/')) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	let resource_path = make_resource_path(request);

	// macOS 上传文件时会附带 PUT 一个 ._xxx 影子文件（扩展属性 / resource fork），
	// 直接丢弃并回 201：回错误会让 Finder 报错重试，存下来则是一堆无意义对象
	if (is_os_metadata_key(resource_path)) {
		return new Response('', { status: 201 });
	}

	// WebDAV 没有标准的分块上传语义。旧实现把 Content-Range 当普通 PUT 处理，
	// 于是"上传第 2 块"会整体覆盖掉第 1 块，静默产出被截断的文件。明确拒绝，
	// 不要让客户端以为续传成功了。
	if (request.headers.has('Content-Range')) {
		return new Response('Partial uploads are not supported', { status: 501 });
	}

	const dirpath = parent_path(resource_path);
	if (dirpath !== '') {
		const parent = await bucket.head(dirpath);
		if (parent === null) {
			// Finder 等客户端会直接 PUT 深层路径而不先 MKCOL，这里自动补建父目录
			await bucket.put(dirpath, new Uint8Array(), {
				customMetadata: { resourcetype: '<collection />' },
			});
		} else if (!is_collection(parent)) {
			// RFC 4918 §9.7.1：中间路径存在但丯非集合 → 409。
			// 旧实现只检查"是否存在"，父路径是个文件时也照写，
			// 结果同一个 key 对 PROPFIND 是文件、对网页界面却是目录。
			return new Response('Conflict', { status: 409 });
		}
	}

	// Stream upload for better memory efficiency with large files
	const stored = await bucket.put(resource_path, request.body, {
		onlyIf: request.headers,
		httpMetadata: request.headers,
	});

	// R2 在写前条件不满足时返回 null（不抛错）。旧实现忽略了返回值，把被 R2 拒绝的
	// 写入谎报成 201 Created —— 客户端以为上传成功，实际拿到的是旧内容。
	if (stored === null) {
		return new Response('Precondition Failed', { status: 412 });
	}

	return new Response('', { status: 201 });
}

async function handle_delete(request: Request, bucket: R2Bucket): Promise<Response> {
	return delete_path(bucket, make_resource_path(request));
}

/**
 * 按**已解码**的路径删除。单独抽出来给 MOVE 复用：MOVE 需要先删掉目标，
 * 若通过"拼 URL 再重建 Request"的方式复用，含字面 `%` 的 key 会在反复编解码中错位。
 */
async function delete_path(bucket: R2Bucket, resource_path: string): Promise<Response> {
	// 旧实现把 DELETE / 当成"清空整个 bucket"执行：任何客户端（包括同步软件的探测
	// 请求）对根路径发一次 DELETE 就会不可逆地销毁全部数据。这里明确拒绝，
	// 需要整桶清空请直接对 R2 bucket 操作。
	if (resource_path === '') {
		return new Response('Refusing to delete the bucket root', { status: 403 });
	}

	const resource = await resource_exists(bucket, resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (!resource.is_collection) {
		await bucket.delete(resource_path);
		return new Response(null, { status: 204 });
	}
	// 隐式目录没有标记对象，delete() 无事可做；子对象由下面的 prefix 删除处理
	if (resource.object !== null) {
		await bucket.delete(resource_path);
	}

	// Batch delete collection contents with size limit
	let r2_objects,
		cursor: string | undefined = undefined;
	do {
		r2_objects = await bucket.list({
			prefix: resource_path + '/',
			cursor: cursor,
		});
		let keys = r2_objects.objects.map((object) => object.key);
		if (keys.length > 0) {
			// Process in batches to respect limits
			for (let i = 0; i < keys.length; i += PERFORMANCE_CONFIG.MAX_BATCH_DELETE_SIZE) {
				const batch = keys.slice(i, i + PERFORMANCE_CONFIG.MAX_BATCH_DELETE_SIZE);
				await bucket.delete(batch);
			}
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);

	return new Response(null, { status: 204 });
}

async function handle_mkcol(request: Request, bucket: R2Bucket): Promise<Response> {
	// Stupid Windows Explorer carries the body, we have to support it.
	// So dont check for request.body.
	// if (request.body) {
	// 	return new Response('Unsupported Media Type', { status: 415 });
	// }

	let resource_path = make_resource_path(request);

	// Check if the resource already exists
	let resource = await bucket.head(resource_path);
	if (resource !== null) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// 父集合必须存在，且必须真的是集合（RFC 4918 §9.3.1 → 409）
	const parent_dir = parent_path(resource_path);
	if (parent_dir !== '') {
		const parent = await bucket.head(parent_dir);
		if (parent === null || !is_collection(parent)) {
			return new Response('Conflict', { status: 409 });
		}
	}

	// 目录标记只是个占位对象，把 MKCOL 的请求头当 httpMetadata 存进去没有意义
	await bucket.put(resource_path, new Uint8Array(), {
		customMetadata: { resourcetype: '<collection />' },
	});
	return new Response('', { status: 201 });
}

type PropfindRequest = { mode: 'allprop' | 'propname' | 'prop'; names: string[] };

/**
 * 解析 PROPFIND 请求体。
 *
 * 无 body 或 `<allprop/>` → 全部属性；`<propname/>` → 只要属性名；
 * `<prop>…</prop>` → 只返回点名的属性（RFC 4918 §9.1）。
 * 旧实现完全忽略请求体，无论客户端要什么都返回全部 13 个属性。
 */
async function parse_propfind_body(request: Request): Promise<PropfindRequest> {
	const text = (await request.text()).trim();
	if (text === '') {
		return { mode: 'allprop', names: [] };
	}
	if (/<(?:[\w.-]+:)?propname\b/i.test(text)) {
		return { mode: 'propname', names: [] };
	}
	const block = /<(?:[\w.-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?prop>/i.exec(text);
	if (block === null) {
		return { mode: 'allprop', names: [] };
	}
	// 属性名去掉命名空间前缀并统一小写（DAV 属性名本身都是小写）
	const names = [...block[1].matchAll(/<([\w.-]+:)?([\w.-]+)/g)].map((match) => match[2].toLowerCase());
	return { mode: 'prop', names: [...new Set(names)] };
}

/** 值本身就是 XML 片段的属性，不能转义。 */
const RAW_XML_PROPS = new Set(['resourcetype', 'supportedlock', 'lockdiscovery']);

function render_property(name: string, value: string): string {
	return RAW_XML_PROPS.has(name) ? `<${name}>${value}</${name}>` : `<${name}>${escape_xml(value)}</${name}>`;
}

function propstat(inner: string, status: string): string {
	return `
		<propstat>
			<prop>
			${inner}
			</prop>
			<status>HTTP/1.1 ${status}</status>
		</propstat>`;
}

/**
 * 生成一条 <response>。
 *
 * `object` 为 null 表示没有标记对象的条目（桶根或隐式目录）；`collection` 为 true 时
 * href 必须带尾斜杠，否则客户端会把它当文件。
 * 被点名但不存在的属性按 RFC 4918 §9.1 用 404 propstat 回报。
 *
 * `locks` 是整张锁表；`lockdiscovery` 由它当场渲染（§15.8：没有锁时属性仍然存在，只是
 * 含 0 个 <activelock>，所以不能简单省略这个属性）。
 */
function generate_propfind_response(
	key: string,
	collection: boolean,
	object: R2Object | null,
	propfind: PropfindRequest,
	locks: LockRecord[],
): string {
	const href = key === '' ? '/' : `/${escape_xml(encode_path(key))}${collection ? '/' : ''}`;
	const available = Object.entries(fromR2Object(object)).filter(([, value]) => value !== undefined) as Array<
		[string, string]
	>;

	const active_locks = locks.filter((lock) => lock_covers(lock, key));
	if (active_locks.length > 0) {
		const rendered = active_locks.map((lock) => render_activelock(lock, lock_href(lock.path))).join('');
		const index = available.findIndex(([name]) => name === 'lockdiscovery');
		if (index === -1) {
			available.push(['lockdiscovery', rendered]);
		} else {
			available[index] = ['lockdiscovery', rendered];
		}
	}

	let propstats: string;
	if (propfind.mode === 'propname') {
		propstats = propstat(available.map(([name]) => `<${name} />`).join('\n\t\t\t\t'), '200 OK');
	} else if (propfind.mode === 'prop') {
		const found: string[] = [];
		const missing: string[] = [];
		for (const name of propfind.names) {
			const match = available.find(([known]) => known === name);
			if (match === undefined) {
				missing.push(`<${name} />`);
			} else {
				found.push(render_property(match[0], match[1]));
			}
		}
		propstats = '';
		if (found.length > 0) {
			propstats += propstat(found.join('\n\t\t\t\t'), '200 OK');
		}
		if (missing.length > 0) {
			propstats += propstat(missing.join('\n\t\t\t\t'), '404 Not Found');
		}
		if (propstats === '') {
			propstats = propstat('', '200 OK');
		}
	} else {
		propstats = propstat(available.map(([name, value]) => render_property(name, value)).join('\n\t\t\t\t'), '200 OK');
	}

	return `
	<response>
		<href>${href}</href>${propstats}
	</response>`;
}

async function handle_propfind(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	const propfind = await parse_propfind_body(request);
	// 一次读锁表，给每条 <response> 复用；锁的个数是个位数，不随目录大小增长
	const locks = await read_locks(bucket);
	let target_is_collection: boolean;
	let truncated = false;
	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	if (resource_path === '') {
		page += generate_propfind_response('', true, null, propfind, locks);
		target_is_collection = true;
	} else {
		const resource = await resource_exists(bucket, resource_path);
		if (resource === null) {
			return new Response('Not Found', { status: 404 });
		}
		target_is_collection = resource.is_collection;
		page += generate_propfind_response(resource_path, resource.is_collection, resource.object, propfind, locks);
	}

	if (target_is_collection) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		const prefix = resource_path === '' ? resource_path : resource_path + '/';
		switch (depth) {
			case '0':
				break;
			case '1': {
				const listing = await listDir(bucket, prefix);
				for (const entry of listing.entries) {
					if (is_os_metadata_key(entry.key)) continue; // 历史遗留的影子文件也不暴露给客户端
					page += generate_propfind_response(entry.key, entry.is_collection, entry.object, propfind, locks);
				}
				truncated = listing.truncated;
				break;
			}
			case 'infinity': {
				const listing = await listRecursive(bucket, prefix);
				for (const object of listing.objects) {
					if (is_os_metadata_key(object.key)) continue;
					page += generate_propfind_response(object.key, is_collection(object), object, propfind, locks);
				}
				truncated = listing.truncated;
				break;
			}
			default: {
				// RFC 4918 §10.2：Depth 不是 0/1/infinity 时要求回 400（旧实现回 403）
				return new Response('Bad Request', { status: 400 });
			}
		}
	}

	// 截断必须显式暴露：WebDAV 没有分页游标，客户端拿不到超限以后的条目，
	// 静默截断会让它以为目录里只有这些内容。<responsedescription> 是 RFC 4918 里的
	// 合法元素，再额外给一个响应头方便脚本与运维检测。
	if (truncated) {
		page += `\n<responsedescription>Listing truncated at ${PERFORMANCE_CONFIG.MAX_OBJECTS_PER_REQUEST} entries; this collection has more members than can be enumerated in a single response.</responsedescription>`;
	}

	page += '\n</multistatus>\n';
	return new Response(page, {
		status: 207,
		headers: {
			'Content-Type': 'text/xml',
			...(truncated ? { 'X-WebDAV-Truncated': 'true' } : {}),
		},
	});
}

/** 解析 PROPPATCH 请求体里的 <set> / <remove> 属性名。 */
async function parse_proppatch_body(request: Request): Promise<{ set: string[]; remove: string[] }> {
	const text = await request.text();
	const result: { set: string[]; remove: string[] } = { set: [], remove: [] };
	const sections = text.matchAll(/<(?:[\w.-]+:)?(set|remove)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1>/gi);
	for (const section of sections) {
		const action = section[1].toLowerCase() === 'set' ? 'set' : 'remove';
		const block = /<(?:[\w.-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?prop>/i.exec(section[2]);
		if (block === null) {
			continue;
		}
		// 属性名去命名空间前缀；匹配用的字符集不含 XML 元字符，可以直接当标签名回显
		for (const match of block[1].matchAll(/<([\w.-]+:)?([\w.-]+)/g)) {
			result[action].push(match[2].toLowerCase());
		}
	}
	result.set = [...new Set(result.set)];
	result.remove = [...new Set(result.remove)];
	return result;
}

/**
 * PROPPATCH。
 *
 * 旧实现在这里用 HTMLRewriter 解析，但处理器只注册在 `propertyupdate` 一个元素上，
 * `<set>` / `<remove>` / 具体属性从未被访问，`setProperties` 永远是空的 —— 于是响应是
 * 一个**空的 <multistatus>**：既没解析、也没存储、也没告诉客户端失败。
 *
 * 现在按 RFC 4918 §9.2 明确回答：这些属性都不会被设置，因此逐个报 403
 * （§9.2 要求服务器不设置的属性必须回 403，并且整个请求必须原子地失败）。
 *
 * 不实现“死属性”是刻意的取舍：R2 binding 没有“只改元数据”的接口，要存属性就必须把整个
 * 对象重传一遍（自定义元数据还有 2 KiB 上限），而 Finder / Windows 每次上传都会发
 * PROPPATCH —— 代价与收益完全不成比例。所以这里保持零写入，并如实告知客户端。
 * 若将来确实需要死属性，正确做法是旁路对象（sidecar）或 Durable Objects。
 */
async function handle_proppatch(request: Request, bucket: R2Bucket): Promise<Response> {
	const resource_path = make_resource_path(request);

	const resource = await resource_exists(bucket, resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	const patch = await parse_proppatch_body(request);
	const requested = [...new Set([...patch.set, ...patch.remove])];
	const href = resource_path === '' ? '/' : `/${escape_xml(encode_path(resource_path))}`;
	const failed = requested.length > 0;

	let responseXML = '<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n';
	responseXML += `  <response>\n    <href>${href}</href>\n    <propstat>\n      <prop>\n`;
	for (const name of requested) {
		responseXML += `        <${name} />\n`;
	}
	responseXML += `      </prop>\n      <status>HTTP/1.1 ${failed ? '403 Forbidden' : '200 OK'}</status>\n    </propstat>\n`;
	if (failed) {
		responseXML += `    <responsedescription>This server does not implement dead properties, so no property was changed.</responsedescription>\n`;
	}
	responseXML += '  </response>\n</multistatus>';

	return new Response(responseXML, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset="utf-8"',
		},
	});
}

async function handle_copy(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let dont_overwrite = request.headers.get('Overwrite') === 'F';
	const destination = resolve_destination(request, request.headers.get('Destination'));
	if (destination instanceof Response) {
		return destination;
	}
	// 覆盖桶根本身没有意义，旧实现会把内容散落到根目录
	if (destination === '') {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the parent directory exists
	const destination_parent = parent_path(destination);
	if (destination_parent !== '' && !(await bucket.head(destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	const destination_exists = (await resource_exists(bucket, destination)) !== null;
	if (dont_overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	const resource = await resource_exists(bucket, resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (resource_path === destination) {
		return new Response('Bad Request', { status: 400 });
	}

	const done = () => (destination_exists ? new Response(null, { status: 204 }) : new Response('', { status: 201 }));

	// 成员数超限时必须在**任何写操作之前**失败：旧实现只处理前 3000 个成员却照常回 201，
	// 客户端以为整体成功，实际少了数据。
	let members: R2Object[] | null = null;
	if (resource.is_collection && (request.headers.get('Depth') ?? 'infinity') === 'infinity') {
		const listing = await listRecursive(bucket, resource_path + '/');
		if (listing.truncated) {
			return too_many_members(resource_path);
		}
		members = listing.objects;
	}

	const is_dir = resource.is_collection;

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const copy = async (object: R2Object) => {
					if (is_os_metadata_key(object.key)) return; // 影子文件不复制
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: object.customMetadata,
						});
					}
				};

				// 集合自身：隐式目录没有标记对象，直接在目标位置补一个
				if (resource.object === null) {
					await put_collection_marker(bucket, destination);
				} else {
					await copy(resource.object);
				}

				await processWithConcurrencyLimit(members ?? [], copy);

				return done();
			}
			case '0': {
				// RFC 4918 §9.8.3：Depth: 0 只复制集合本身，不含成员
				if (resource.object === null) {
					await put_collection_marker(bucket, destination);
					return done();
				}
				let object = await bucket.get(resource.object.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: object.customMetadata,
				});
				return done();
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		const source_object = resource.object;
		if (source_object === null) {
			return new Response('Not Found', { status: 404 });
		}
		let src = await bucket.get(source_object.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: src.customMetadata,
		});
		return done();
	}
}

async function handle_move(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	// RFC 4918 §10.6：请求未携带 Overwrite 时视作 T。旧实现只在显式 T 时覆盖，
	// 于是 Finder/rclone 的"覆盖式改名"全部收到 412，而且与 COPY 的默认值相反。
	const overwrite = request.headers.get('Overwrite') !== 'F';
	const destination = resolve_destination(request, request.headers.get('Destination'));
	if (destination instanceof Response) {
		return destination;
	}
	if (destination === '') {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the parent directory exists
	const destination_parent = parent_path(destination);
	if (destination_parent !== '' && !(await bucket.head(destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	const destination_exists = (await resource_exists(bucket, destination)) !== null;
	if (!overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	const resource = await resource_exists(bucket, resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (resource_path === destination) {
		return new Response('Bad Request', { status: 400 });
	}

	const done = () => (destination_exists ? new Response(null, { status: 204 }) : new Response('', { status: 201 }));

	const depth = request.headers.get('Depth') ?? 'infinity';
	// RFC 4918 §9.9.3：集合的 MOVE 只允许 Depth: infinity。旧实现在 Depth: 0 时只搬走
	// 目录标记对象，子对象全部留在原 prefix 下 —— 那批对象随后既不出现在任何列表里，
	// 也无法用原来的路径删除，只能按完整 key 或整桶操作才能到达。
	if (resource.is_collection && depth !== 'infinity') {
		return new Response('Depth must be infinity for MOVE on a collection', { status: 400 });
	}

	// 成员数超限时必须在**任何写操作之前**失败：MOVE 会先删掉目标再逐个搬，
	// 若中途才发现成员过多，就会留下"目标已删、源端只剩一部分"的半成品状态。
	let members: R2Object[] | null = null;
	if (resource.is_collection) {
		const listing = await listRecursive(bucket, resource_path + '/');
		if (listing.truncated) {
			return too_many_members(resource_path);
		}
		members = listing.objects;
	}

	if (destination_exists) {
		// Delete the destination first（destination 已经是解码后的路径）
		await delete_path(bucket, destination);
	}

	const is_dir = resource.is_collection;

	if (is_dir) {
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const move = async (object: R2Object) => {
					// 影子文件不搬走，但要从源端删掉，免得留下永远看不见的孤儿对象
					if (is_os_metadata_key(object.key)) {
						await bucket.delete(object.key);
						return;
					}
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: object.customMetadata,
						});
						await bucket.delete(object.key);
					}
				};

				// 集合自身：目标端补一个标记对象，源端标记对象删掉（隐式目录本来就没有）
				await put_collection_marker(bucket, destination);
				if (resource.object !== null) {
					await bucket.delete(resource.object.key);
				}

				await processWithConcurrencyLimit(members ?? [], move);

				return done();
			}
			case '0': {
				// 上面已保证集合的 Depth 只能是 infinity，所以这里一定是文件
				const source_object = resource.object;
				if (source_object === null) {
					return new Response('Not Found', { status: 404 });
				}
				const object = await bucket.get(source_object.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: object.customMetadata,
				});
				await bucket.delete(source_object.key);
				return done();
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		const source_object = resource.object;
		if (source_object === null) {
			return new Response('Not Found', { status: 404 });
		}
		const src = await bucket.get(source_object.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: src.customMetadata,
		});
		await bucket.delete(source_object.key);
		return done();
	}
}

/**
 * 锁状态存放位置。
 *
 * 为什么不放“真锁”：Workers 隔离环境没有跨请求共享内存，锁必须落到共享存储才算数。
 * 而 R2 没有“只改元数据”的接口（见 B8），所以不能把锁写进被锁对象本身，只能旁路存。
 *
 * 放在单个 key `._locks` 上有两个好处：
 *  1. `.` 开头的 key 本来就被 `is_os_metadata_key()` 过滤，不会出现在任何列表里；
 *  2. 只有一个 key、不含 `/`，不会产生 `delimitedPrefixes`，看不到“幽灵目录”。
 *
 * 仍然是 **advisory** 的：LOCK/UNLOCK 之间的一致性（423 / 409 / 400 / 201、lockdiscovery）
 * 现在是真的，但 PUT/DELETE 不会强制要求提交锁令牌 —— 一旦解析 `If` 头出错，Office/Finder
 * 的保存流程会直接失败，那是必须单独验证的一步，见 docs/webdav-fix-list.md。
 */
const LOCK_STORE_KEY = '._locks';
/** Timeout 上界。客户端可以请求 Infinite，但服务器有权选一个自己支持的值（§6.6）。 */
const MAX_LOCK_SECONDS = 604800;
const DEFAULT_LOCK_SECONDS = 3600;

type LockScope = 'exclusive' | 'shared';

type LockRecord = {
	path: string;
	token: string;
	scope: LockScope;
	depth: '0' | 'infinity';
	owner: string;
	expires: number;
};

/** 某个锁是否覆盖这个路径：锁根自身，或 depth=infinity 的祖先（间接锁）。 */
function lock_covers(lock: LockRecord, path: string): boolean {
	if (lock.path === path) return true;
	if (lock.depth !== 'infinity') return false;
	if (lock.path === '') return true; // 根上的无限深度锁覆盖一切
	return path.startsWith(`${lock.path}/`);
}

function lock_remaining(lock: LockRecord): number {
	return Math.max(0, lock.expires - Math.floor(Date.now() / 1000));
}

/**
 * 读取锁表，顺带丢掉已过期、以及锁根已不存在的记录。
 *
 * RFC 4918 §6.1 第 8 点要求锁根变成未映射 URL 时锁必须跟着消失。用“读取时校验”实现，
 * 就不用去改 DELETE / MOVE 那几条热路径；代价是每次读锁表多几个 head，而锁的数量
 * 本来就是个位数。
 */
async function read_locks(bucket: R2Bucket): Promise<LockRecord[]> {
	const object = await bucket.get(LOCK_STORE_KEY);
	if (object === null) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await object.text());
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const now = Math.floor(Date.now() / 1000);
	const alive: LockRecord[] = [];
	for (const item of parsed as Partial<LockRecord>[]) {
		if (typeof item.token !== 'string' || typeof item.path !== 'string' || typeof item.expires !== 'number') {
			continue;
		}
		if (item.expires <= now) continue;
		// 空路径是桶根，永远存在（resource_exists 对空路径返回 null 是表示“没有标记对象”）
		if (item.path !== '' && (await resource_exists(bucket, item.path)) === null) continue;
		alive.push({
			path: item.path,
			token: item.token,
			scope: item.scope === 'shared' ? 'shared' : 'exclusive',
			depth: item.depth === '0' ? '0' : 'infinity',
			owner: typeof item.owner === 'string' ? item.owner : '',
			expires: item.expires,
		});
	}
	return alive;
}

async function write_locks(bucket: R2Bucket, locks: LockRecord[]): Promise<void> {
	await bucket.put(LOCK_STORE_KEY, JSON.stringify(locks));
}

/** 解析 Timeout 请求头（§10.7）。服务器有权挑一个自己支持的值，所以永远钳到上界。 */
function parse_timeout(header: string | null): number {
	if (header === null) {
		return DEFAULT_LOCK_SECONDS;
	}
	for (const candidate of header.split(',')) {
		const value = candidate.trim();
		if (value === 'Infinite') {
			return MAX_LOCK_SECONDS;
		}
		const match = /^Second-(\d+)$/.exec(value);
		if (match !== null) {
			return Math.min(Math.max(Number(match[1]), 1), MAX_LOCK_SECONDS);
		}
	}
	return DEFAULT_LOCK_SECONDS;
}

/**
 * 取出 If 头里被提交的状态令牌（§10.4）。
 * Resource-Tag（</path> 或 <http://…>）不是令牌，靠 URI scheme 前缀区分。
 */
function submitted_tokens(header: string | null): string[] {
	if (header === null) {
		return [];
	}
	const tokens: string[] = [];
	for (const match of header.matchAll(/<([^>]*)>/g)) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(match[1])) {
			tokens.push(match[1]);
		}
	}
	return tokens;
}

/** 解析 lockinfo 请求体。拿不到合法的 lockscope 就是格式错误（§8.2 → 400）。 */
function parse_lockinfo(body: string): { scope: LockScope; owner: string } | null {
	const scope_match = /<(?:[\w.-]+:)?lockscope\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?lockscope>/i.exec(body);
	if (scope_match === null) {
		return null;
	}
	const scope: LockScope | null = /<(?:[\w.-]+:)?shared\b/i.test(scope_match[1])
		? 'shared'
		: /<(?:[\w.-]+:)?exclusive\b/i.test(scope_match[1])
			? 'exclusive'
			: null;
	if (scope === null) {
		return null;
	}
	const owner_match = /<(?:[\w.-]+:)?owner\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?owner>/i.exec(body);
	return { scope: scope, owner: owner_match === null ? '' : owner_match[1].trim() };
}

/**
 * 渲染一条 <activelock>。
 *
 * `<lockroot>` 在 §14.1 的 DTD 里是**必需**元素（客户端靠它判断锁覆盖到哪），
 * 而 §14.12 明确要求“SHOULD include this in all DAV:lockdiscovery values and the
 * response to LOCK requests” —— 旧实现从来没给过。
 */
function render_activelock(lock: LockRecord, root_href: string): string {
	const owner = lock.owner === '' ? '' : `<owner>${lock.owner}</owner>`;
	return `<activelock><locktype><write/></locktype><lockscope><${lock.scope}/></lockscope><depth>${lock.depth}</depth>${owner}<timeout>Second-${lock_remaining(lock)}</timeout><locktoken><href>${escape_xml(lock.token)}</href></locktoken><lockroot><href>${escape_xml(root_href)}</href></lockroot></activelock>`;
}

/** LOCK 的响应体：DAV:lockdiscovery 包在 prop 里（§9.10.1）。 */
function lock_body(lock: LockRecord, root_href: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<prop xmlns="DAV:">
	<lockdiscovery>${render_activelock(lock, root_href)}</lockdiscovery>
</prop>`;
}

/** 锁相关路径的 href 形式（编码后带前导斜杠）。 */
function lock_href(path: string): string {
	return path === '' ? '/' : `/${encode_path(path)}`;
}

/**
 * RFC 4918 §16 的前置条件错误体。各 condition 允许的子元素不同：
 * `no-conflicting-lock` 与 `lock-token-submitted` 带 href，`lock-token-matches-request-uri` 必须为空。
 */
function precondition_error(status: number, condition: string, hrefs: string[]): Response {
	const inner = hrefs.map((href) => `<href>${escape_xml(href)}</href>`).join('');
	const body = `<?xml version="1.0" encoding="utf-8"?>
<error xmlns="DAV:">
	<${condition}>${inner}</${condition}>
</error>`;
	return new Response(body, { status: status, headers: { 'Content-Type': 'application/xml' } });
}

/**
 * RFC 4918 §9.10。
 *
 * 旧实现是个彻底的假桩：任何请求都发一个新 token 并回 200（LOCK 不存在的资源也回 200）、
 * 已持有的锁再锁一次照旧回 200、`<lockroot>` 从来没有、Timeout 头不回、刷新锁也不认。
 */
async function handle_lock(request: Request, bucket: R2Bucket): Promise<Response> {
	const resource_path = make_resource_path(request);
	const depth_header = request.headers.get('Depth');
	// §9.10.3：LOCK 的 Depth 只能是 0 或 infinity；没给就等于 infinity
	if (depth_header !== null && depth_header !== '0' && depth_header !== 'infinity') {
		return new Response('Depth must be 0 or infinity on LOCK', { status: 400 });
	}
	const depth: '0' | 'infinity' = depth_header === '0' ? '0' : 'infinity';
	const root_href = new URL(request.url).pathname;
	const seconds = parse_timeout(request.headers.get('Timeout'));
	const body = await request.text();
	const locks = await read_locks(bucket);

	// 无请求体 = 刷新已有锁（§9.10.2）：必须用 If 头指明刷新哪一把
	if (body.trim() === '') {
		const tokens = submitted_tokens(request.headers.get('If'));
		if (tokens.length === 0) {
			// §9.10.1 要求“新建锁必须有 XML 请求体”，§7.7 要求“无体的 LOCK 不得创建新锁”。
			// 既没有体、又没有令牌，无法判断客户端意图 → 400
			return new Response('LOCK without a body must name the lock to refresh in an If header', { status: 400 });
		}
		const target = locks.find((lock) => tokens.includes(lock.token) && lock_covers(lock, resource_path));
		if (target === undefined) {
			// §9.10.6：令牌不在 Request-URI 的作用域内（锁已消失，或本就不覆盖这里）
			return precondition_error(412, 'lock-token-matches-request-uri', []);
		}
		target.expires = Math.floor(Date.now() / 1000) + seconds;
		await write_locks(bucket, locks);
		// §9.10.2：刷新成功**不**回 Lock-Token 头，但响应体要给出更新后的 lockdiscovery
		return new Response(lock_body(target, root_href), {
			status: 200,
			headers: { 'Content-Type': 'application/xml', Timeout: `Second-${seconds}` },
		});
	}

	const info = parse_lockinfo(body);
	if (info === null) {
		return new Response('Malformed lockinfo body', { status: 400 });
	}

	// §9.10.5 兼容表：已持有独占锁 → 任何新锁都不兼容；已持有共享锁 + 新锁要独占 → 不兼容。
	// 请求 depth=infinity 时还要看后代已有的锁，否则整棵子树上的锁会被悄悄绕过。
	const subtree = depth === 'infinity' && resource_path !== '' ? `${resource_path}/` : null;
	const conflicting = locks.find((lock) => {
		const overlaps = lock_covers(lock, resource_path) || (subtree !== null && lock.path.startsWith(subtree));
		return overlaps && (lock.scope === 'exclusive' || info.scope === 'exclusive');
	});
	if (conflicting !== undefined) {
		// §9.10.6：已存在不兼容的锁 → 423 + no-conflicting-lock（带上冲突锁的根，省掉客户端一次查询）
		return precondition_error(423, 'no-conflicting-lock', [lock_href(conflicting.path)]);
	}

	// 桶根始终存在（resource_exists 对空路径返回 null 是为了表达“没有标记对象”）
	const resource =
		resource_path === '' ? { object: null, is_collection: true } : await resource_exists(bucket, resource_path);

	// §9.10.4 / §7.3：对未映射 URL 加锁成功必须**创建**一个空的（非集合）资源，并回 201。
	let created = false;
	if (resource === null) {
		const parent = parent_path(resource_path);
		if (parent !== '') {
			const parent_resource = await resource_exists(bucket, parent);
			// §9.10.6：中间集合不存在 → 409，服务器不得自动补建
			if (parent_resource === null || !parent_resource.is_collection) {
				return new Response('Conflict', { status: 409 });
			}
		}
		await bucket.put(resource_path, new Uint8Array());
		created = true;
	}

	const lock: LockRecord = {
		path: resource_path,
		token: `opaquelocktoken:${crypto.randomUUID()}`,
		scope: info.scope,
		depth: depth,
		owner: info.owner,
		expires: Math.floor(Date.now() / 1000) + seconds,
	};
	await write_locks(bucket, [...locks, lock]);

	return new Response(lock_body(lock, root_href), {
		status: created ? 201 : 200,
		headers: {
			'Content-Type': 'application/xml',
			'Lock-Token': `<${lock.token}>`,
			// §18.2：class 2 必须提供 Time-Out 响应头（我们 OPTIONS 里声明了 dav: 1, 2）
			Timeout: `Second-${seconds}`,
		},
	});
}

/** RFC 4918 §9.11。旧实现无条件回 204，连令牌都从不校验。 */
async function handle_unlock(request: Request, bucket: R2Bucket): Promise<Response> {
	const resource_path = make_resource_path(request);
	const header = request.headers.get('Lock-Token');
	if (header === null || header.trim() === '') {
		// §9.11.1：没有提供锁令牌 → 400（不是 204）
		return new Response('UNLOCK requires a Lock-Token header', { status: 400 });
	}
	const token = header.trim().replace(/^</, '').replace(/>$/, '');
	const locks = await read_locks(bucket);
	const target = locks.find((lock) => lock.token === token);
	if (target === undefined || !lock_covers(target, resource_path)) {
		// §9.11.1 + §16：资源没被锁、或 Request-URI 不在该锁的作用域内 → 409
		return precondition_error(409, 'lock-token-matches-request-uri', []);
	}
	await write_locks(
		bucket,
		locks.filter((lock) => lock.token !== token),
	);
	return new Response(null, { status: 204 });
}

const DAV_CLASS = '1, 2';
export const SUPPORT_METHODS = [
	'OPTIONS',
	'PROPFIND',
	'PROPPATCH',
	'MKCOL',
	'GET',
	'HEAD',
	'PUT',
	'DELETE',
	'COPY',
	'MOVE',
	'LOCK',
	'UNLOCK',
];

export async function dispatch_handler(request: Request, bucket: R2Bucket): Promise<Response> {
	switch (request.method) {
		case 'OPTIONS': {
			return new Response(null, {
				status: 204,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
		case 'HEAD': {
			return await handle_head(request, bucket);
		}
		case 'GET': {
			return await handle_get(request, bucket);
		}
		case 'PUT': {
			return await handle_put(request, bucket);
		}
		case 'DELETE': {
			return await handle_delete(request, bucket);
		}
		case 'MKCOL': {
			return await handle_mkcol(request, bucket);
		}
		case 'PROPFIND': {
			return await handle_propfind(request, bucket);
		}
		case 'PROPPATCH': {
			return await handle_proppatch(request, bucket);
		}
		case 'COPY': {
			return await handle_copy(request, bucket);
		}
		case 'MOVE': {
			return await handle_move(request, bucket);
		}
		case 'LOCK': {
			return await handle_lock(request, bucket);
		}
		case 'UNLOCK': {
			return await handle_unlock(request, bucket);
		}
		default: {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
	}
}
