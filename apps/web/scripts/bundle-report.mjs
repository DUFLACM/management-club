import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// 以 Vite manifest 的静态 imports 递归计算，不把其他面板的动态 imports 算入概览。
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dist = path.join(root, 'apps/web/dist');
const manifest = JSON.parse(fs.readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8'));
const visited = new Set();
const styles = new Set();
function walk(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Manifest 缺少 ${key}`);
  for (const css of chunk.css ?? []) styles.add(css);
  for (const imported of chunk.imports ?? []) walk(imported);
}
walk('index.html');
walk('src/workspaces/member/panels/OverviewPanel.tsx');
function size(file) {
  const bytes = fs.readFileSync(path.join(dist, file));
  return { file, rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length };
}
const js = [...visited].map((key) => size(manifest[key].file)).sort((a, b) => b.gzipBytes - a.gzipBytes);
const css = [...styles].map(size);
const brandLogo = size('brand/nav-logo-dark.png');
const total = (rows) => rows.reduce((sum, row) => sum + row.gzipBytes, 0);
const report = { generatedAt: new Date().toISOString(), scope: 'entry + member overview 的递归静态 imports（去重），默认 gzip 压缩；不是网络传输实测', js, css,
  jsGzipBytes: total(js), cssGzipBytes: total(css), jsBudgetBytes: 200 * 1024, cssBudgetBytes: 50 * 1024,
  publicEntryAssets: [{ file: brandLogo.file, rawBytes: brandLogo.rawBytes, description: '用户指定学校 Logo；匿名入口/登录/注册按需显示，未包含在 JS/CSS 预算中' }] };
const out = path.join(root, 'docs/ui-preview');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'bundle.json'), JSON.stringify(report, null, 2) + '\n');
const table = (rows) => rows.map((row) => `| ${row.file.split('/').at(-1)} | ${row.rawBytes.toLocaleString('en-US')} | ${row.gzipBytes.toLocaleString('en-US')} |`).join('\n');
fs.writeFileSync(path.join(root, 'apps/web/src/BUILD_NOTES.md'), `# @acm/web 构建记录\n\n日期：2026-10-05。使用 Node 24.21.0 / pnpm 12.4.2 / Vite 8.3.2。\n\n命令：\n\n\x60\x60\x60bash\npnpm --filter @acm/web build\nnode apps/web/scripts/bundle-report.mjs\n\x60\x60\x60\n\n计算口径：读取 dist/.vite/manifest.json，递归遍历 index.html 与成员 OverviewPanel 的静态 imports，并按文件去重；不遍历 dynamicImports。gzip 来自 node:zlib 默认设置，未包含 HTTP 头、HTML 与压缩协商差异。17 面板已真实实现，旧占位面板的 144 KB 记录已替换。\n\n## 成员概览必需 JS\n\n| 文件 | raw (B) | gzip (B) |\n| --- | ---: | ---: |\n${table(js)}\n\n总计 **${report.jsGzipBytes.toLocaleString('en-US')} B（${(report.jsGzipBytes / 1024).toFixed(2)} KiB）**；优化目标 180 KiB、验收上限 200 KiB。\n\n## 首屏 CSS\n\n| 文件 | raw (B) | gzip (B) |\n| --- | ---: | ---: |\n${table(css)}\n\n总计 **${report.cssGzipBytes.toLocaleString('en-US')} B（${(report.cssGzipBytes / 1024).toFixed(2)} KiB）**；目标 35 KiB、上限 50 KiB。\n\n## 分包与实测边界\n\n17 个面板通过 React.lazy 按 section 加载；扫码、rating 图表、二维码生成是额外动态 chunk。概览的小型六个月 SVG 同步加载；管理面板不进入概览的静态依赖。完整机器清单见 docs/ui-preview/bundle.json。\n\n用户指定学校 Logo 为额外 PNG 资源，原始大小 ${brandLogo.rawBytes.toLocaleString('en-US')} B（${(brandLogo.rawBytes / 1024).toFixed(2)} KiB），在匿名入口/登录/注册显示；没有计入 JS/CSS 合计。扫码解码库按需加载，不进入概览首屏静态依赖。\n\n以上为实际构建文件压缩大小；LCP/INP/CLS 的用户 p75 与目标服务器 API p95/签到并发压测尚未取得，不以此构建体积替代运行性能验收。\n`);
console.log(`概览 JS ${(report.jsGzipBytes / 1024).toFixed(2)} KiB / 200 KiB；CSS ${(report.cssGzipBytes / 1024).toFixed(2)} KiB / 50 KiB`);
if (report.jsGzipBytes > report.jsBudgetBytes || report.cssGzipBytes > report.cssBudgetBytes) process.exitCode = 1;
