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

// 客户端脚本 src/archive.client.js 的声明放在 src/archive.client.d.ts ——
// 那条不能用环境声明写，原因见那个文件里的说明。
