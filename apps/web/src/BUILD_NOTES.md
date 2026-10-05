# @acm/web 构建记录

日期：2026-10-05。使用 Node 24.21.0 / pnpm 12.4.2 / Vite 8.3.2。

命令：

```bash
pnpm --filter @acm/web build
node apps/web/scripts/bundle-report.mjs
```

计算口径：读取 dist/.vite/manifest.json，递归遍历 index.html 与成员 OverviewPanel 的静态 imports，并按文件去重；不遍历 dynamicImports。gzip 来自 node:zlib 默认设置，未包含 HTTP 头、HTML 与压缩协商差异。17 面板已真实实现，旧占位面板的 144 KB 记录已替换。

## 成员概览必需 JS

| 文件 | raw (B) | gzip (B) |
| --- | ---: | ---: |
| vendor-react-DjX0U0Iu.js | 218,840 | 67,527 |
| vendor-radix-Y5ysCW-q.js | 115,512 | 36,683 |
| index-TH1tfbdu.js | 81,400 | 21,988 |
| vendor-router-CoWZujvy.js | 38,494 | 13,751 |
| dist-CwtWLyls.js | 28,224 | 8,928 |
| vendor-query-rM_Osx55.js | 29,435 | 8,904 |
| vendor-lucide-Bsm3Lv7a.js | 26,018 | 8,450 |
| OverviewPanel-BdVzykqY.js | 11,632 | 3,419 |
| QueryBoundary-C7K_jcKZ.js | 6,069 | 2,603 |
| StatusBadge-BwDF3yYH.js | 3,325 | 1,331 |
| MonthBars-DFoKH7MV.js | 1,756 | 1,007 |
| button-R5udIYeG.js | 1,506 | 719 |
| card-BO15IRMX.js | 1,045 | 500 |
| rolldown-runtime-CbXtAM7H.js | 589 | 368 |

总计 **176,178 B（172.05 KiB）**；优化目标 180 KiB、验收上限 200 KiB。

## 首屏 CSS

| 文件 | raw (B) | gzip (B) |
| --- | ---: | ---: |
| index-DCM4kLrb.css | 65,806 | 11,799 |

总计 **11,799 B（11.52 KiB）**；目标 35 KiB、上限 50 KiB。

## 分包与实测边界

17 个面板通过 React.lazy 按 section 加载；扫码、rating 图表、二维码生成是额外动态 chunk。概览的小型六个月 SVG 同步加载；管理面板不进入概览的静态依赖。完整机器清单见 docs/ui-preview/bundle.json。

用户指定学校 Logo 为额外 PNG 资源，原始大小 32,000 B（31.25 KiB），在匿名入口/登录/注册显示；没有计入 JS/CSS 合计。扫码解码库按需加载，不进入概览首屏静态依赖。

以上为实际构建文件压缩大小；LCP/INP/CLS 的用户 p75 与目标服务器 API p95/签到并发压测尚未取得，不以此构建体积替代运行性能验收。
