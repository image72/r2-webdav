/**
 * 外部编辑器注册表（可选模块，整块可下线）。
 *
 * 与 src/onlyoffice.ts 同一套模式：这里**只**负责把「哪个编辑器处理哪些扩展名」
 * 注入页面配置（index.ts 的 `__APP_CONFIG__`）。真正的打开/保存在浏览器端完成
 * （src/editors.client.js）—— 编辑器跑在 iframe 里，通过 postMessage 把结果交给
 * 宿主页面，由页面 own 的 Basic 会话直接 PUT 回本服务。服务端没有会话端点、
 * 没有签名短链：编辑器从头到尾接触不到 WebDAV。
 *
 * 下线方式：删本文件 + index.ts 里搜 EDITORS 的接线 + wrangler.toml 的两个 URL 变量。
 */

export type EditorDef = {
	/** 稳定 id，客户端 adapter 按它分派（drawio / photopea）。 */
	id: string;
	/** 显示名（UI 按钮文案用）。 */
	name: string;
	/** 编辑器页面基址。 */
	url: string;
	/** 允许打开的扩展名（全小写）。 */
	extensions: string[];
};

export type EditorsEnv = {
	DRAWIO_EDITOR_URL?: string;
	PHOTOPEA_EDITOR_URL?: string;
};

/**
 * 白名单只收**能原样保存回去**的格式：
 * - draw.io：.drawio 原生 + drawio XML（.xml）。vsdx/gliffy 只进不出（保存会变 XML），
 *   放进来等于让用户一键毁掉原格式，不放。
 * - Photopea：PSD/PSB 原生 + 有对应 saveToOE 导出格式的位图/矢量。sketch/xd/fig/ai
 *   这类「只读打开」的同样不放。
 */
const REGISTRY: Array<Omit<EditorDef, 'url'>> = [
	{ id: 'drawio', name: 'draw.io', extensions: ['drawio', 'xml'] },
	{
		id: 'photopea',
		name: 'Photopea',
		extensions: ['psd', 'psb', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg'],
	},
];

const BUILT_IN: Record<string, { url: string | undefined }> = {
	drawio: { url: undefined },
	photopea: { url: undefined },
};

/**
 * 页面配置：配了哪些编辑器就给哪些，没配返回 null（页面入口不出现）。
 * 地址解析失败视同没配，别让一个坏 URL 把页面搞挂。
 */
export function editors_page_config(env: EditorsEnv): EditorDef[] | null {
	const defs: EditorDef[] = [];
	for (const entry of REGISTRY) {
		const raw = entry.id === 'drawio' ? env.DRAWIO_EDITOR_URL : env.PHOTOPEA_EDITOR_URL;
		if (!raw) continue;
		try {
			new URL(raw);
		} catch {
			continue;
		}
		defs.push({ ...entry, url: raw.replace(/\/+$/, '') + '/' });
	}
	return defs.length === 0 ? null : defs;
}

// BUILT_IN 仅用于把「注册表 id ↔ 环境变量」的对应关系写在一处，避免散落 if/else。
void BUILT_IN;
