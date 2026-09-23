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

import { PERFORMANCE_CONFIG, is_os_metadata_key, listDir, listRecursive, processWithConcurrencyLimit } from './r2';
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
		// 这些值会直接拼进 XML，必须转义：Content-Disposition 之类里的 & 与 <
		// 会让整个 multistatus 变成非法 XML，所有客户端都解析不了。
		displayname: object.httpMetadata?.contentDisposition
			? escape_xml(object.httpMetadata.contentDisposition)
			: undefined,
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
	let path = new URL(request.url).pathname.slice(1);
	path = path.endsWith('/') ? path.slice(0, -1) : path;
	return path;
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
	return path.endsWith('/') ? path.slice(0, -1) : path;
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
		return new Response('Not Found', { status: 404 });
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
	let resource_path = make_resource_path(request);

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

/**
 * 隐式目录（没有标记对象，由其它工具直接写入深层 key 造成）的 <response>。
 * href 必须带尾斜杠，否则客户端会把它当文件；属性用 fromR2Object(null) 合成。
 */
function generate_implicit_collection_response(key: string): string {
	return `
	<response>
		<href>/${escape_xml(key)}/</href>
		<propstat>
			<prop>
			${Object.entries(fromR2Object(null))
				.filter(([, value]) => value !== undefined)
				.map(([name, value]) => `<${name}>${value}</${name}>`)
				.join('\n\t\t\t\t')}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
}

function generate_propfind_response(object: R2Object | null): string {
	if (object === null) {
		return `
	<response>
		<href>/</href>
		<propstat>
			<prop>
			${Object.entries(fromR2Object(null))
				.filter(([_, value]) => value !== undefined)
				.map(([key, value]) => `<${key}>${value}</${key}>`)
				.join('\n				')}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
	}

	// href 里的 & 与 < 同样会破坏 XML，这里一并转义
	let href = `/${escape_xml(object.key)}${object.customMetadata?.resourcetype === '<collection />' ? '/' : ''}`;
	return `
	<response>
		<href>${href}</href>
		<propstat>
			<prop>
			${Object.entries(fromR2Object(object))
				.filter(([_, value]) => value !== undefined)
				.map(([key, value]) => `<${key}>${value}</${key}>`)
				.join('\n				')}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
}

async function handle_propfind(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	let target_is_collection: boolean;
	let truncated = false;
	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	if (resource_path === '') {
		page += generate_propfind_response(null);
		target_is_collection = true;
	} else {
		const resource = await resource_exists(bucket, resource_path);
		if (resource === null) {
			return new Response('Not Found', { status: 404 });
		}
		target_is_collection = resource.is_collection;
		// 隐式目录也要给出带尾斜杠的 href，否则客户端会把它当文件
		page +=
			resource.object === null
				? generate_implicit_collection_response(resource_path)
				: generate_propfind_response(resource.object);
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
					page +=
						entry.object === null
							? generate_implicit_collection_response(entry.key)
							: generate_propfind_response(entry.object);
				}
				truncated = listing.truncated;
				break;
			}
			case 'infinity': {
				const listing = await listRecursive(bucket, prefix);
				for (const object of listing.objects) {
					if (is_os_metadata_key(object.key)) continue;
					page += generate_propfind_response(object);
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

async function handle_proppatch(request: Request, bucket: R2Bucket): Promise<Response> {
	const resource_path = make_resource_path(request);

	// 检查资源是否存在
	let object = await bucket.head(resource_path);
	if (object === null) {
		return new Response('Not Found', { status: 404 });
	}

	// 使用 HTMLRewriter 直接流式解析请求体，避免 await request.text()
	const setProperties: { [key: string]: string } = {};
	const removeProperties: string[] = [];
	let currentAction: 'set' | 'remove' | null = null;
	let currentPropName: string | null = null;
	let currentPropValue: string = '';

	class PropHandler {
		element(element: Element) {
			const tagName = element.tagName.toLowerCase();
			if (tagName === 'set') {
				currentAction = 'set';
			} else if (tagName === 'remove') {
				currentAction = 'remove';
			} else if (tagName === 'prop') {
				// 忽略 <prop> 标签
			} else {
				// 属性名称
				currentPropName = tagName;
				currentPropValue = '';
			}
		}

		text(textChunk: Text) {
			if (currentPropName) {
				currentPropValue += textChunk.text;
			}
		}

		end(element: Element) {
			if (currentAction === 'set' && currentPropName) {
				setProperties[currentPropName] = currentPropValue.trim();
			} else if (currentAction === 'remove' && currentPropName) {
				removeProperties.push(currentPropName);
			}
			currentPropName = null;
			currentPropValue = '';
		}
	}

	// 使用 HTMLRewriter 直接解析 request.body 流，避免内存加载
	await new HTMLRewriter().on('propertyupdate', new PropHandler()).transform(new Response(request.body)).arrayBuffer();

	// 复制原有的自定义元数据
	const customMetadata = object.customMetadata ? { ...object.customMetadata } : {};

	// 更新元数据
	for (const propName in setProperties) {
		customMetadata[propName] = setProperties[propName];
	}

	for (const propName of removeProperties) {
		delete customMetadata[propName];
	}

	// 更新对象的元数据
	const src = await bucket.get(object.key);
	if (src === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(object.key, src.body, {
		httpMetadata: object.httpMetadata,
		customMetadata: customMetadata,
	});

	// 构造响应
	let responseXML = '<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n';

	for (const propName in setProperties) {
		responseXML += `
    <response>
        <href>/${object.key}</href>
        <propstat>
            <prop>
                <${propName} />
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>\n`;
	}

	for (const propName of removeProperties) {
		responseXML += `
    <response>
        <href>/${object.key}</href>
        <propstat>
            <prop>
                <${propName} />
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>\n`;
	}

	responseXML += '</multistatus>';

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
		// Delete the destination first（用已校验过 host 的路径重建请求）
		await handle_delete(new Request(new URL(`/${destination}`, request.url), request), bucket);
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

async function handle_lock(request: Request, bucket: R2Bucket): Promise<Response> {
	// Simple lock response - no actual locking implementation
	const lockToken = `opaquelocktoken:${crypto.randomUUID()}`;
	const lockXML = `<?xml version="1.0" encoding="utf-8"?>
<prop xmlns="DAV:">
	<lockdiscovery>
		<activelock>
			<locktype><write/></locktype>
			<lockscope><exclusive/></lockscope>
			<depth>0</depth>
			<timeout>Second-3600</timeout>
			<locktoken><href>${lockToken}</href></locktoken>
		</activelock>
	</lockdiscovery>
</prop>`;

	return new Response(lockXML, {
		status: 200,
		headers: {
			'Content-Type': 'application/xml',
			'Lock-Token': `<${lockToken}>`,
		},
	});
}

async function handle_unlock(request: Request, bucket: R2Bucket): Promise<Response> {
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
