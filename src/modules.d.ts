/**
 * 文本模块的 TS 声明。
 *
 * wrangler 通过 `[[rules]] type = "Text"` 把 .html 当字符串导入（见 wrangler.toml），
 * 但 TS 不认识这个后缀，所以在这里补一条环境声明。
 * 没有它会报 TS2307: Cannot find module './index.html'。
 */
declare module '*.html' {
	const content: string;
	export default content;
}

/** Locale packs are inlined into the page as JSON strings (kept out of R2 data space). */
declare module '*.json' {
	const content: unknown;
	export default content;
}

/**
 * 注意：allowJs 若改回 true，真文件会重新被解析成模块，此声明即失效（TS2306）。
 */
declare module '*.client.js' {
	const source: string;
	export default source;
}
/** 同 .client.js：office.templates.js 也是文本模块（allowJs=false，不让真文件进编译图）。 */
declare module '*.templates.js' {
	const source: string;
	export default source;
}
