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

import { PERFORMANCE_CONFIG, is_os_metadata_key, listAll, processWithConcurrencyLimit } from './r2';
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
		displayname: object.httpMetadata?.contentDisposition,
		getcontentlanguage: object.httpMetadata?.contentLanguage,
		getcontentlength: object.size.toString(),
		getcontenttype: object.httpMetadata?.contentType,
		getetag: object.etag,
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
	} else {
		let object = await bucket.get(resource_path, {
			onlyIf: request.headers,
			range: request.headers,
		});

		let isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
			return 'body' in object;
		};

		if (object === null) {
			return new Response('Not Found', { status: 404 });
		} else if (!isR2ObjectBody(object)) {
			return new Response('Precondition Failed', { status: 412 });
		} else {
			const { rangeOffset, rangeEnd } = calcContentRange(object);
			const contentLength = rangeEnd - rangeOffset + 1;
			return new Response(object.body, {
				status: object.range && contentLength !== object.size ? 206 : 200,
				headers: {
					'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
					'Content-Length': contentLength.toString(),
					...{ 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` },
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
	}
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

	// Auto-create parent directories if they don't exist (for Finder compatibility)
	let dirpath = resource_path.split('/').slice(0, -1).join('/');
	if (dirpath !== '') {
		let dir = await bucket.head(dirpath);
		if (!dir) {
			// Create parent directory automatically
			await bucket.put(dirpath, new Uint8Array(), {
				customMetadata: { resourcetype: '<collection />' },
			});
		}
	}

	// Stream upload for better memory efficiency with large files
	await bucket.put(resource_path, request.body, {
		onlyIf: request.headers,
		httpMetadata: request.headers,
	});
	return new Response('', { status: 201 });
}

async function handle_delete(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	if (resource_path === '') {
		// Batch delete all objects with size limit
		let r2_objects,
			cursor: string | undefined = undefined;
		do {
			r2_objects = await bucket.list({ cursor: cursor });
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

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	await bucket.delete(resource_path);
	if (resource.customMetadata?.resourcetype !== '<collection />') {
		return new Response(null, { status: 204 });
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

	// Check if the parent directory exists
	let parent_dir = resource_path.split('/').slice(0, -1).join('/');
	if (parent_dir !== '' && !(await bucket.head(parent_dir))) {
		return new Response('Conflict', { status: 409 });
	}

	await bucket.put(resource_path, new Uint8Array(), {
		httpMetadata: request.headers,
		customMetadata: { resourcetype: '<collection />' },
	});
	return new Response('', { status: 201 });
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

	let href = `/${object.key + (object.customMetadata?.resourcetype === '<collection />' ? '/' : '')}`;
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

	let is_collection: boolean;
	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	if (resource_path === '') {
		page += generate_propfind_response(null);
		is_collection = true;
	} else {
		let object = await bucket.head(resource_path);
		if (object === null) {
			return new Response('Not Found', { status: 404 });
		}
		is_collection = object.customMetadata?.resourcetype === '<collection />';
		page += generate_propfind_response(object);
	}

	if (is_collection) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case '0':
				break;
			case '1':
				{
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let object of listAll(bucket, prefix)) {
						if (is_os_metadata_key(object.key)) continue; // 历史遗留的影子文件也不暴露给客户端
						page += generate_propfind_response(object);
					}
				}
				break;
			case 'infinity':
				{
					// Limit infinity depth for performance
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					let objectCount = 0;
					for await (let object of listAll(bucket, prefix, true, PERFORMANCE_CONFIG.MAX_OBJECTS_PER_REQUEST)) {
						if (objectCount >= PERFORMANCE_CONFIG.MAX_OBJECTS_PER_REQUEST) {
							break; // Prevent excessive processing
						}
						if (is_os_metadata_key(object.key)) continue;
						page += generate_propfind_response(object);
						objectCount++;
					}
				}
				break;
			default: {
				return new Response('Forbidden', { status: 403 });
			}
		}
	}

	page += '\n</multistatus>\n';
	return new Response(page, {
		status: 207,
		headers: {
			'Content-Type': 'text/xml',
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
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = new URL(destination_header).pathname.slice(1);
	destination = destination.endsWith('/') ? destination.slice(0, -1) : destination;

	// Check if the parent directory exists
	let destination_parent = destination
		.split('/')
		.slice(0, destination.endsWith('/') ? -2 : -1)
		.join('/');
	if (destination_parent !== '' && !(await bucket.head(destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (dont_overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

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

				// Copy root resource first
				await copy(resource);

				// Process child objects with concurrency limit
				const childObjects: R2Object[] = [];
				for await (let object of listAll(bucket, prefix, true)) {
					childObjects.push(object);
				}

				await processWithConcurrencyLimit(childObjects, copy);

				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			case '0': {
				let object = await bucket.get(resource.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: object.customMetadata,
				});
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: src.customMetadata,
		});
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return new Response('', { status: 201 });
		}
	}
}

async function handle_move(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let overwrite = request.headers.get('Overwrite') === 'T';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = new URL(destination_header).pathname.slice(1);
	destination = destination.endsWith('/') ? destination.slice(0, -1) : destination;

	// Check if the parent directory exists
	let destination_parent = destination
		.split('/')
		.slice(0, destination.endsWith('/') ? -2 : -1)
		.join('/');
	if (destination_parent !== '' && !(await bucket.head(destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (!overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (resource.key === destination) {
		return new Response('Bad Request', { status: 400 });
	}

	if (destination_exists) {
		// Delete the destination first
		await handle_delete(new Request(new URL(destination_header), request), bucket);
	}

	let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
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

				// Move root resource first
				await move(resource);

				// Process child objects with concurrency limit
				const childObjects: R2Object[] = [];
				for await (let object of listAll(bucket, prefix, true)) {
					childObjects.push(object);
				}

				await processWithConcurrencyLimit(childObjects, move);

				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			case '0': {
				let object = await bucket.get(resource.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: object.customMetadata,
				});
				await bucket.delete(resource.key);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: src.customMetadata,
		});
		await bucket.delete(resource.key);
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return new Response('', { status: 201 });
		}
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
