/**
 * src/archive.client.js 是**给浏览器**的脚本，由 Worker 当静态资源原样发出去
 * （见 wrangler.toml 把它注册成「文本模块」，以及 ui.ts 的 handle_asset_request）。
 * 它并不是给 Worker 自己 import 的代码，所以这里必须补一条声明，把它的默认导出
 * 描述成字符串 —— 否则 `import ARCHIVE_JS from './archive.client.js'` 会把那个真实
 * 的 JS 模块当成导入对象（allowJs 打开时 TS 一定会解析到真文件），
 * 拿到的就不是源码文本了。
 *
 * 为什么用同名的 .d.ts 而不是 `declare module '*.client.js'`：后者是环境声明，
 * 只在模块**解析失败**时才会被采用；allowJs 下真文件解析得到，环境声明永远轮不上。
 */
declare const source: string;
export default source;
