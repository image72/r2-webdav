/**
 * src/archive.client.js / src/editors.client.js 是「文本模块」：
 * wrangler.toml 的 [[rules]] 把它们注册成 Text，Worker import 时拿到的默认导出是
 * 源码字符串，由 ui.ts 当静态资源原样发给浏览器 —— 它们不是给 Worker 执行的代码。
 *
 * 通配声明只在 TS **解析不到真文件**时生效（allowJs 关闭后正是这种情形）：
 * 这样就不必为每个浏览器脚本维护一份同名 .d.ts。
 * 注意：allowJs 若改回 true，真文件会重新被解析成模块，此声明即失效（TS2306）。
 */
declare module '*.client.js' {
	const source: string;
	export default source;
}
