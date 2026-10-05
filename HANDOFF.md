# 交接文档

> 项目：大连外国语大学 ACM 算法协会积分管理系统，`/Users/recode/Desktop/management-club`。
> 更新日期：2026-10-05。权威需求为 `docs/scheme/` 与 `docs/*.pdf`，总任务书为 `docs/scheme/06-glm53-implementation-prompt.md`。

## 0. 当前可接手状态

技术栈为 NestJS 12、PostgreSQL 18 / Prisma 7、React 19 / Vite 8 / Tailwind v4、独立 Node Worker、pnpm monorepo。API 前缀 `/api/v1`，业务响应包络 `{data, meta}`。

原交接 A–D 中本轮面板、Hydro Bridge、截图与构建收尾已完成。此结论限定上述交付与本地验证，不代表所有业务子流程闭环；线上参赛仍有内部软件缺口，须与校方/OJ 外部条件分别记录。

- 数据模型 60+ 表、7 个真实迁移；校园编号相关字段统一为 `VARCHAR(64)` + `^[A-Za-z0-9._-]{1,64}$` CHECK，另包含本地管理员凭证/gate/验证码/限流表、活跃绑定/积分 source_key/队列 dedupe 部分唯一索引。
- 已有后端业务模块、Worker 与 OpenAPI 的基础流程已实现；线上参赛闭环仍有未实现子流程；R01–R13 仍按制度未决语义阻塞受影响的正式结算。
- 17 个前端业务面板已实现，16 个至少部分接入业务 API。RulesPanel 是明确标注的本地制度默认参考，未读取数据库生效规则版本，不能描述为在线规则编辑器。
- Hydro Bridge 已构建，60 项 fixture/契约测试通过；未在真实 Hydro/Mongo 实例安装运行。
- 本轮实测：7 包 `pnpm build`、161 项单测（57 scoring +60 Hydro +25 API +19 web）、51 项真实 PG 集成与 `pnpm run typecheck` 通过；本地管理员 5 项、注册/教职工 9 项均在真实 PG 集成中。7 个迁移已实际 deploy，`prisma migrate status` 为 schema up to date。独立 lint 未配置。
- 业务基线 `docs/ui-preview/manifest.json` 记录 85 张 /184 检查，真实本地数据库中的演示 fixture；新增 entry-manifest 45 张 /274 检查、camera-manifest 2 张 /10 检查均 errors=[]，另有 sidebar-manifest 2 张 /14 项纯布局 mock 检查通过，合计 134 张 /482 项自动检查，四组档位分别记录。
- 已切换为真实校园 CAS 配置，根 `.env` 保持 `AUTH_DEV_SIMULATOR=false`；API 已按该配置重启，`/api/v1/auth/csrf` 返回 200。学校登录页 HTTP 200；项目 CAS 客户端已向真实 `proxyValidate` 核验合成无效票，收到 `INVALID_TICKET`（抛 `CAS_AUTH_FAILURE`）。固定公网解析地址配置保留 TLS 主机名校验与 SSRF 私网拒绝。没有有效校园账号成功登录证据，没有校方生产联调结论。

## 1. 启动与复验

```bash
./scripts/dev-postgres.sh          # 本地 PG 5433；无 Homebrew 可用 docker compose up -d
cp .env.example .env               # 默认真实 CAS，AUTH_DEV_SIMULATOR=false
pnpm install
pnpm db:migrate
pnpm db:seed                       # 仅开发演示数据
pnpm dev:api                       # 127.0.0.1:8080
pnpm dev:web                       # localhost:5173（/api 代理）
pnpm dev:worker
pnpm build
pnpm test                         # 当前 161：57 scoring +60 Hydro +25 API +19 web
pnpm test:integration              # 真实 PG 51；专用测试库会重建
pnpm run typecheck
```

默认登录跳转学校真实 CAS。精确本地 service 为 `http://localhost:5173/api/v1/auth/cas/callback?flow=<random>`，需校方允许该地址及 flow 形式；不能把固定回调加 cookie 当作等价替代。成功响应的 `id_number/user_name/user_id` 属性与 `id_type` 仍须实证。

需要模拟演示或截图时，只在本地显式使用 `NODE_ENV=development AUTH_DEV_SIMULATOR=true pnpm dev:api` 并重启 API；校园编号 `202600001`，模拟口令来自本地环境变量。业务截图还需显式准备 UI fixture 并对脚本进程开启模拟，不能只让 API 开启模拟；以下仅是复跑说明，不修改当前根 `.env`：

```bash
AUTH_DEV_SIMULATOR=true pnpm --filter @acm/db seed:ui
AUTH_DEV_SIMULATOR=true pnpm screenshot
```

业务截图使用 dev CAS、真实 HTTP、真实 PG 中的演示 fixture，不代表校方成功登录。结束后重启普通 API 恢复真实模式。新增验收保持真实默认，摄像头脚本依赖本机 ffmpeg：

```bash
pnpm --filter @acm/web exec node scripts/entry-screenshot.mjs
pnpm --filter @acm/web exec node scripts/invitation-camera-check.mjs
pnpm --filter @acm/web exec node scripts/sidebar-layout-check.mjs
```

## 2. 原 A–D 收尾结果

| 原任务 | 当前结果 | 证据 |
| --- | --- | --- |
| A：前端 17 面板 | 面板实现与本地收尾完成；16 至少部分接业务 API +1 本地制度参考；不代表全部竞赛子流程闭环 | `apps/web/src/workspaces/`、截图清单 |
| B：截图验收 | 85 张业务基线 /184 检查，另 45 张真实匿名/管理员入口 /274 检查、2 张测试摄像头 /10 检查、2 张 mock 布局 /14 检查；8 视口、明暗主题 | `docs/ui-preview/manifest.json`、`docs/acceptance-report.md` §7、附录 A /B |
| C：Hydro Bridge | 可构建；60 项 fixture/契约测试通过，真实实例未安装 | `packages/hydro-bridge/` |
| D：构建/测试/文档 | 七包构建、161 单测、51 PG 集成、7 migrations up to date、typecheck 通过；验收与状态已更新 | README、implementation-status、acceptance-report |

当前概览必需静态 JS gzip 为 **176,130 B（172.00 KiB）**，CSS 为 **11,375 B（11.11 KiB）**；学校 logo 原始 PNG 额外 32,000 B（31.25 KiB），未计入 JS/CSS 合计。以上仅是构建压缩/资源字节，非网络传输或 LCP/INP/CLS 结论。最终以 `docs/ui-preview/bundle.json` / `apps/web/src/BUILD_NOTES.md` 为准。

手机三页统一单行品牌头与主卡、首页 CAS 一次直达学校、logo 回首页、真实 CSRF 延迟加载、注册相机扫码与独立管理员登录已补充 47 张截图；其中管理员账号/验证码第二步使用隔离 UI fixture，未提交真实凭据。平板侧栏 2 张 /14 检查单列为几何 mock，见验收附录 A /B。

## 3. 未完成软件功能与外部条件

### 内部软件待办

线上参赛当前可用的是 `/app?section=activities` 的平台活动详情、社团报名、申请远程（先进入 pending）和去平台报名外链；`/app?section=contests` 的平台记录支持人工审核绑定与申请刷新。手动账本与通用审核也已存在。这些功能不等于完整线上赛事闭环。

| 内部缺口 | 实际边界 / 需补工作 |
| --- | --- |
| 纯线上活动模式 | 发布仍强制 attendancePolicy；需要独立的线上发布与资格流程，不能用线下签到配置冒充 |
| 指定赛事与备案实时目录 | 竞赛页相应区域目前为说明，实时目录与业务操作尚未接入 |
| 正式赛事报名与组队 | 缺少该模型的专用 API 与页面；活动社团报名、平台外链不能替代正式赛事流程 |
| 远程申请管理操作 | 后端 remote permission review 审批 API 已存在，管理前端缺专门审批操作/队列；不能写成后端无审批 |
| CF 完整参赛证据与成绩 | 当前有 rating /赛事目录，逐题提交证据与完整参赛结果尚未落入认定/成绩库 |
| 完赛材料、晋级资格与自动积分 | 材料核验、有效提交/参赛、晋级队员资格及自动入账链未接；networkQualifierScore 有纯函数测试，但 API /Worker 未调用 |
| Hydro pull Worker | `apps/worker/src/handlers.ts` 中拉取处理器仍为占位；插件可构建/协议测试通过不代表拉取链完成 |

关键位置为 `apps/web/src/workspaces/member/panels/ContestsPanel.tsx`、`apps/api/src/modules/activities/activity.service.ts`、`apps/api/src/modules/attendance/attendance.admin.controller.ts`、`apps/worker/src/handlers.ts` 与 `packages/scoring-core/src/award-score.ts`。以上是需要补开发的软件缺口，与校方白名单、真实实例和 R01–R13 制度未决分别记录；本轮只做只读审计，未擅自实现新的制度解释或竞赛流程。

### 外部条件与仍未执行的验收

1. **校园 CAS**：已配置真实模式并完成只读接口连通性检查；仍需校方 service 白名单、有效票据成功属性、学生登录/邀请注册全链路。不得写成端到端校园成功。
2. **教职工 CAS 与实际地点**：软件已支持 `register-staff` 受控预登记，首次 CAS 登录按校园编号和姓名匹配并绑定稳定 subject；仍需用校方有效教职工账号验证 `id_number/user_name/user_id` 契约和 service 白名单。真实地点须采样、独立认证与现场验收，不将开发坐标视为真实认证。
3. **Hydro/Mongo**：准备真实实例、安装插件、核验实际集合/版本/权限/签名投递与重放；当前 connector 保持 disabled。
4. **制度 R01–R13**：由协会确认口径并发布规则版本；不写死任意解释，不取消阻塞来制造通过。
5. **真机与性能**：iOS Safari、Android Chrome、微信/QQ 内置浏览器、定位/相机权限与弱网；目标服务器读/签到 p95、RUM 的 LCP/INP/CLS 仍未执行。
6. **头像完整链路**：本轮未重跑 HTTP 上传→Worker 处理→设置头像；不能将代码存在或历史说明写成本轮验收通过。

## 4. 已踩过的坑

1. 数据库会话必须 UTC。新库执行 `ALTER DATABASE <db> SET timezone TO 'UTC';`，避免 CAS flow 等过期判断偏移 8 小时。
2. CAS XML 解析必须保留 `parseTagValue:false`，否则 `001234567` 会被转为数字并丢失前导零。`id_number` 是 1–64 位 `[A-Za-z0-9._-]` opaque 校园编号，须按文本原样验证；编号长度不能决定 student/staff。
3. Prisma 7 datasource URL 在 `packages/db/prisma.config.ts`；迁移后 generate + db build，DateTime 使用 `@db.Timestamptz(3)`。
4. pnpm 12 的 `allowBuilds` 保持 true/false；业务时区 Asia/Shanghai 在应用层，DB 会话始终 UTC。
5. R01 `monthlyRounding=pending` 故意阻塞正式月结算，集成测试断言该行为。
6. 真实 CAS 运行默认与测试模拟分开；修改根 `.env` 后需重启 API，集成测试 setup 显式使用模拟配置，与根 `.env` 的真实模式隔离。

## 5. 范围与关键位置

不部署公开站点，不向真实成员发消息，不写真实平台账户；production 禁止模拟器；不按校园编号长度猜测学生/教职工，也不让未预登记身份自动成为 staff；不编造未执行的测试或性能数据；首期不引入 Redis/微服务。

| 位置 | 内容 |
| --- | --- |
| `prisma/schema.prisma`、`prisma/migrations/` | 表结构与迁移、自定义约束 |
| `packages/scoring-core/src/` | 积分纯函数与 RULE_GAPS |
| `apps/api/src/modules/auth/` | CAS flow、教职工首次绑定、独立本地管理员、模拟器、邀请注册、会话、CSRF |
| `apps/api/src/modules/{venues,activities,attendance}/` | 地点、活动、签到与锁顺序 |
| `apps/api/src/modules/{scoring,members,profiles,settings,platforms}/` | 账本、成员、主页、设置、平台 |
| `apps/worker/src/{main,handlers}.ts` | 队列与处理器 |
| `packages/integrations/src/`、`packages/hydro-bridge/` | 平台适配、SSRF、Hydro 协议与插件 |
| `packages/db/src/seed.ts`、`apps/api/src/cli.ts` | 开发种子、`init-local-admin`、`register-staff` 与受控角色初始化 |
| `docs/{deploy,implementation-status,acceptance-report}.md` | 部署、分档状态、实测记录 |
| `docs/ui-preview/{manifest,entry-manifest,camera-manifest,sidebar-manifest,bundle}.json` | 截图/自动检查与构建字节明细 |
