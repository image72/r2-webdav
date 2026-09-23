// R2 访问的共享工具，被 WebDAV 层与页面层复用。

// Performance configuration constants
export const PERFORMANCE_CONFIG = {
	MAX_OBJECTS_PER_REQUEST: 3000, // Limit for directory listings
	MAX_PROPFIND_DEPTH: 5, // Maximum depth for PROPFIND infinity requests
	MAX_CONCURRENT_OPERATIONS: 50, // Concurrent operations limit
	// R2 的 delete() 每次最多接受 1000 个 key（见 Workers API reference）。旧值写成 3000，
	// 只是因为 key 都来自 list() 的分页（每页 ≤1000）才碰巧没有越界。
	MAX_BATCH_DELETE_SIZE: 1000,
} as const;

export type ListEntry = {
	/** 条目的 key；目录不带尾斜杠 */
	key: string;
	/** 真实存在的对象；隐式目录（没有标记对象）为 null */
	object: R2Object | null;
	is_collection: boolean;
};

/**
 * 列出某个前缀下的**直接**子项（等价于 WebDAV 的 Depth: 1）。
 *
 * R2 的 list() 只返回对象，目录若缺少标记对象（例如由 S3 API 或其它工具直接写入
 * `a/b/c.txt` 而从未创建 `a/`）就只会出现在 `delimitedPrefixes` 里。旧实现完全忽略该
 * 字段，于是这类"隐式目录"在任何列表里都看不到，`DELETE` 也回 404。
 * 这里把两种来源合并，隐式目录合成一条 object 为 null 的条目。
 *
 * 超过 max 条时 `truncated` 为 true：调用方**必须**把它暴露给客户端，
 * 而不是像旧实现那样静默截断（那会让客户端以为目录里只有这些内容）。
 */
export async function listDir(
	bucket: R2Bucket,
	prefix: string,
	max: number = PERFORMANCE_CONFIG.MAX_OBJECTS_PER_REQUEST,
): Promise<{ entries: ListEntry[]; truncated: boolean }> {
	const entries: ListEntry[] = [];
	const seen = new Set<string>();
	const implicit: string[] = [];
	let cursor: string | undefined;

	while (true) {
		const page = await bucket.list({
			prefix: prefix,
			delimiter: '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (const object of page.objects) {
			seen.add(object.key);
			entries.push({
				key: object.key,
				object: object,
				is_collection: object.customMetadata?.resourcetype === '<collection />',
			});
		}

		// delimitedPrefixes 里的目录可能已经有标记对象（上面已收集），去重后再当作隐式目录
		for (const delimited of page.delimitedPrefixes ?? []) {
			const key = delimited.endsWith('/') ? delimited.slice(0, -1) : delimited;
			if (!seen.has(key)) {
				implicit.push(key);
			}
		}

		cursor = page.truncated ? page.cursor : undefined;
		if (cursor === undefined || entries.length + implicit.length >= max) {
			break;
		}
	}

	let truncated = cursor !== undefined;
	for (const key of implicit) {
		if (entries.length >= max) {
			truncated = true;
			break;
		}
		entries.push({ key: key, object: null, is_collection: true });
	}
	if (entries.length > max) {
		entries.length = max;
		truncated = true;
	}

	return { entries, truncated };
}

/**
 * 递归列出某个前缀下的**所有**对象（等价于 WebDAV 的 Depth: infinity）。
 *
 * 返回 `truncated` 强制调用方显式处理"还有更多"的情况：旧实现是静默停在 3000 条，
 * COPY/MOVE 因此会"成功"地只处理一部分，把其余对象丢掉或留成孤儿。
 */
export async function listRecursive(
	bucket: R2Bucket,
	prefix: string,
	max: number = PERFORMANCE_CONFIG.MAX_OBJECTS_PER_REQUEST,
): Promise<{ objects: R2Object[]; truncated: boolean }> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;

	while (true) {
		const page = await bucket.list({
			prefix: prefix,
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;

		// 多取一条用于判断"是否还有更多"，下面再裁掉
		if (objects.length > max) {
			break;
		}
		if (cursor === undefined) {
			break;
		}
	}

	const truncated = objects.length > max || cursor !== undefined;
	if (objects.length > max) {
		objects.length = max;
	}
	return { objects, truncated };
}

// Utility function to process promises with concurrency limit
export async function processWithConcurrencyLimit<T>(
	items: T[],
	processor: (item: T) => Promise<void>,
	concurrencyLimit: number = PERFORMANCE_CONFIG.MAX_CONCURRENT_OPERATIONS,
): Promise<void> {
	const results: Promise<void>[] = [];
	for (let i = 0; i < items.length; i += concurrencyLimit) {
		const batch = items.slice(i, i + concurrencyLimit);
		const batchPromises = batch.map(processor);
		results.push(...batchPromises);
		await Promise.all(batchPromises);
	}
}

/**
 * macOS 通过 WebDAV 挂载点写文件时，会顺带产生一批“影子”对象：
 *   - `._xxx`：AppleDouble，存 resource fork / 扩展属性，每个上传的文件都会配一个
 *   - `.DS_Store` / `.Spotlight-V100` 等：Finder 与 Spotlight 的目录元数据
 * 这些对用户没有意义，只会在存储里悄悄堆积，因此上传层丢弃、列表层隐藏。
 */
const MACOS_METADATA_NAMES = new Set([
	'.DS_Store',
	'.AppleDouble',
	'.Spotlight-V100',
	'.Trashes',
	'.fseventsd',
	'.TemporaryItems',
	'.DocumentRevisions-V100',
	'.VolumeIcon.icns',
	'.apdisk',
	'Network Trash Folder',
	'Temporary Items',
]);

/** 是否为操作系统生成的元数据文件；只看最后一段名字，所以任意层级都生效。 */
export function is_os_metadata_key(key: string): boolean {
	const name = key.slice(key.lastIndexOf('/') + 1);
	return name.startsWith('._') || MACOS_METADATA_NAMES.has(name);
}
