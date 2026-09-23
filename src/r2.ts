// R2 访问的共享工具，被 WebDAV 层与页面层复用。

// Performance configuration constants
export const PERFORMANCE_CONFIG = {
	MAX_OBJECTS_PER_REQUEST: 3000, // Limit for directory listings
	MAX_PROPFIND_DEPTH: 5, // Maximum depth for PROPFIND infinity requests
	MAX_CONCURRENT_OPERATIONS: 50, // Concurrent operations limit
	MAX_BATCH_DELETE_SIZE: 3000, // Maximum objects per batch delete
} as const;

export async function* listAll(bucket: R2Bucket, prefix: string, isRecursive: boolean = false, maxObjects?: number) {
	let cursor: string | undefined = undefined;
	let objectCount = 0;
	const limit = maxObjects ?? PERFORMANCE_CONFIG.MAX_OBJECTS_PER_REQUEST;

	do {
		var r2_objects = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of r2_objects.objects) {
			if (objectCount >= limit) {
				return; // Stop when reaching the limit
			}
			yield object;
			objectCount++;
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated && objectCount < limit);
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
