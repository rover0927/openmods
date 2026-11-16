// 构建 bbcanvas：从本地 blockbench 源码产出只读画布静态站点
// - 复用 blockbench/dist/bundle.js（若缺失则现场 build-web）
// - 拷贝 css/assets/font/icons/lang/keymaps 等运行时资源
// - 打补丁版 index.html：注入 bb-bridge.js（GPL-3.0：修改版需遵 GPL 开源）
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BB = resolve(ROOT, '../blockbench')
const OUT = join(ROOT, 'bbcanvas', 'dist')

if (!existsSync(join(BB, 'dist', 'bundle.js'))) {
  console.log('[bbcanvas] dist/bundle.js 缺失，现场构建 web target…')
  execSync('npm run build-web', { cwd: BB, stdio: 'inherit' })
} else {
  console.log('[bbcanvas] 复用已有 dist/bundle.js（删除 openmods/bbcanvas/dist 后重跑可强制重建）')
}

mkdirSync(OUT, { recursive: true })

// 拷贝 bundle 与运行时资源（保持 dist/ 目录结构，index.html 引用 dist/bundle.js）
mkdirSync(join(OUT, 'dist'), { recursive: true })
cpSync(join(BB, 'dist', 'bundle.js'), join(OUT, 'dist', 'bundle.js'))
if (existsSync(join(BB, 'dist', 'bundle.js.map'))) {
  cpSync(join(BB, 'dist', 'bundle.js.map'), join(OUT, 'dist', 'bundle.js.map'))
}
for (const dir of ['css', 'assets', 'font', 'icons', 'lang', 'keymaps', 'themes', 'build']) {
  const src = join(BB, dir)
  if (existsSync(src)) cpSync(src, join(OUT, dir), { recursive: true })
}
for (const file of ['manifest.webmanifest', 'favicon.png', 'icon.png']) {
  const src = join(BB, file)
  if (existsSync(src)) cpSync(src, join(OUT, file))
}

// 补丁 index.html：注入只读桥接
let html = readFileSync(join(BB, 'index.html'), 'utf8')
// head stub（必须在 bundle 之前）：SW 注册改为 no-op（避免 404）、屏蔽 blckbn.ch 遥测/插件市场跨域噪音
const headStub = `<script>
(function(){
  try { navigator.serviceWorker && navigator.serviceWorker.register && Object.defineProperty(navigator.serviceWorker, 'register', { value: function(){ return Promise.resolve() } }) } catch(e){}
  var _fetch = window.fetch;
  window.fetch = function(input, init){
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('blckbn.ch') !== -1) return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    return _fetch.apply(this, arguments);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url){
    if (typeof url === 'string' && url.indexOf('blckbn.ch') !== -1) url = 'data:text/plain,';
    return _open.call(this, method, url);
  };
})();
</script>`
html = html.replace('<head>', `<head>\n  ${headStub}`)
// 错误收集器（必须在 bundle 之前），便于诊断启动失败
const errCollector = `<script>window.__bbErrors=window.__bbErrors||[];window.addEventListener('error',function(e){window.__bbErrors.push(String(e.message||e)+' @ '+(e.filename||'')+':'+(e.lineno||0))});window.addEventListener('unhandledrejection',function(e){window.__bbErrors.push('promise: '+String(e.reason&&e.reason.message||e.reason))})</script>`
html = html.replace('<head>', `<head>\n  ${errCollector}`)
// 移除 service worker 注册相关的 meta（iframe 内不需要 PWA）
html = html.replace('<script src="./dist/bundle.js" defer></script>', '<script src="./dist/bundle.js" defer></script>\n  <script src="./bb-bridge.js" defer></script>')
if (!html.includes('bb-bridge.js')) {
  // 兜底：bundle 引入方式可能不同，直接在 </body> 前注入
  html = html.replace('</body>', '  <script src="./bb-bridge.js" defer></script>\n</body>')
}
// 避免 service worker 在本地端口缓存旧资源
html = html.replace(/<link[^>]*manifest[^>]*>/g, '')
writeFileSync(join(OUT, 'index.html'), html)

// 桥接脚本 + 空 service worker（Blockbench boot 会注册 ./service_worker.js，空文件避免 404）
cpSync(join(ROOT, 'bbcanvas', 'bb-bridge.js'), join(OUT, 'bb-bridge.js'))
writeFileSync(join(OUT, 'service_worker.js'), '// no-op service worker (openmods kiosk)')

// 清掉上次构建遗留的旧 workbox SW（保留上方写入的空 service_worker.js）
{
  const p = join(OUT, 'sw.js')
  if (existsSync(p)) rmSync(p)
}

console.log(`[bbcanvas] 构建完成 → ${OUT}`)
