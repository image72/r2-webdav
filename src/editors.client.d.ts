/**
 * src/editors.client.js 是给浏览器的脚本（模式同 src/archive.client.js）：
 * 由 Worker 当静态资源原样发出去（wrangler.toml 的 Text 规则 + ui.ts 的资源路由），
 * Worker 自身不执行它。这条声明让 `import EDITORS_JS from './editors.client.js'`
 * 拿到源码文本而不是真实模块。
 */
declare const source: string;
export default source;
