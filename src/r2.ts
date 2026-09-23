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
