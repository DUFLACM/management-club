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

关键位置为 `apps/web/src/workspaces/member/panels/ContestsPanel.tsx`、`apps/api/src/modules/activities/activity.service.ts`、`apps/api/src/modules/attendance/attendance.admin.controller.ts`、`apps/worker/src/handlers.ts` 与 `packages/scoring-core/src/award-score.ts`。

注意一下那个活动也要有可以选择牛客 cf atcoder /学校 oj 竞赛的选项，活动然后活动详情页面我觉得需要做出改变首页页面不适配活动详情怎么敢做卡片全屏覆盖的，然后你的活动详情里面应该有文件功能来上传本次讲题的文件题解 ，允许上传题解的人员页面上应该有对应的按钮上传，报名的时候应该有申请讲题的按钮，申请后台审批通过后即可获得本次活动上传权限，然后比赛名字牛客 cf atcoder /学校 oj  这些做一个卡片可以直接跳到对应比赛页面 然后签入签出那个状态页面可以直接整合到这里 不需要那个冗杂页面 这个活动详情页面样式建议全部重构，并集成对应的签入签出功能，让页面好看起来符合整体主题风格。比赛结束后 应该可以在详情页里面看到本次比赛积分 然后本次通过题目,牛客比赛的排行 api 应该是https://ac.nowcoder.com/acm-heavy/acm/contest/real-time-rank-data?token=&id=140235&rankScope=ALL&limit=0&_=1791220115521 id 对应其比赛 id 其他的你自行探索 ,atcoder 是https://atcoder.jp/contests/abc472/standings/json abc472 对应比赛名字,codeforces 你得自行想办法 我没找到可以考虑用 clist 但要在详情页面说明有延迟。从榜单获得过了的题目,以及没过题目的得分 抓到对应的 url 方便快速访问 别忘了手机端支持。然后有一个本次活动对题数排名在活动详情页面就这样吧。

然后加一个社团积分排行榜页面。做的好看就行

以上所有要求都要保证手机端适配和前端 ui 正常，尽量减少审查内容。

## 4. 已踩过的坑

1. 数据库会话必须 UTC。新库执行 `ALTER DATABASE <db> SET timezone TO 'UTC';`，避免 CAS flow 等过期判断偏移 8 小时。
2. CAS XML 解析必须保留 `parseTagValue:false`，否则 `001234567` 会被转为数字并丢失前导零。`id_number` 是 1–64 位 `[A-Za-z0-9._-]` opaque 校园编号，须按文本原样验证；编号长度不能决定 student/staff。
3. Prisma 7 datasource URL 在 `packages/db/prisma.config.ts`；迁移后 generate + db build，DateTime 使用 `@db.Timestamptz(3)`。
4. pnpm 12 的 `allowBuilds` 保持 true/false；业务时区 Asia/Shanghai 在应用层，DB 会话始终 UTC。
5. R01 `monthlyRounding=pending` 故意阻塞正式月结算，集成测试断言该行为。
6. 真实 CAS 运行默认与测试模拟分开；修改根 `.env` 后需重启 API，集成测试 setup 显式使用模拟配置，与根 `.env` 的真实模式隔离。
7. 综评折算（附录三）默认只在学期 `endsOn` 之后开放。本地测试用 `EVALUATION_TEST_MODE=true`（production 开启会直接启动失败）；此时未结束学期也能生成批次，但批次固定 `is_test=true`，页面与导出文件名都带「测试数据」标记，不能当正式结果上报。附录三只规定 H 的结构，竞赛/服务/纪律三项的具体折算由 `evaluation.service.ts` 顶部注释给出口径并可在管理页逐人覆盖；`RoleGrant` 不区分社长/副社长，故干部口径只单列主席团成员、由主席团手工给分。

8. 讲题满意度评分（`lecture_ratings`）只在活动有「已批准」讲题申请时出现在活动详情页。资格口径：活动 `endAt` 已过 + 本人有入场打点或出勤结论为到场（活动未设 `AttendancePolicy` 时退回「已报名」口径，否则没有出勤结论的讲座会无人可评）+ 讲题人不对本人讲题评分。评分匿名：`rater_user_id` 只用于防重与本人撤改，任何读接口都不返回；汇总仅讲题人本人与 `activity.manage` 可见，匿名评语对讲题人需评分达 3 人（避免反推评价人），审计只记 `lecture_request` 维度、不写评价人主体。

## 5. 范围与关键位置

不部署公开站点，不向真实成员发消息，不写真实平台账户；production 禁止模拟器；不按校园编号长度猜测学生/教职工，也不让未预登记身份自动成为 staff；不编造未执行的测试或性能数据；首期不引入 Redis/微服务。

| 位置 | 内容 |
| --- | --- |
| `prisma/schema.prisma`、`prisma/migrations/` | 表结构与迁移、自定义约束 |
| `packages/scoring-core/src/` | 积分纯函数与 RULE_GAPS |
| `apps/api/src/modules/auth/` | CAS flow、教职工首次绑定、独立本地管理员、模拟器、邀请注册、会话、CSRF |
| `apps/api/src/modules/{venues,activities,attendance}/` | 地点、活动、签到与锁顺序；讲题申请/材料与讲题满意度匿名评分 |
| `apps/api/src/modules/{scoring,members,profiles,settings,platforms}/` | 账本、成员、主页、设置、平台 |
| `apps/api/src/modules/evaluation/` | 综评建议折算（附录三）：H 计算、A/B/C 定档、逐人覆盖、学号/姓名/加分 CSV 导出 |
| `apps/worker/src/{main,handlers}.ts` | 队列与处理器 |
| `packages/integrations/src/`、`packages/hydro-bridge/` | 平台适配、SSRF、Hydro 协议与插件 |
| `packages/db/src/seed.ts`、`apps/api/src/cli.ts` | 开发种子、`init-local-admin`、`register-staff` 与受控角色初始化 |
| `docs/{deploy,implementation-status,acceptance-report}.md` | 部署、分档状态、实测记录 |
| `docs/ui-preview/{manifest,entry-manifest,camera-manifest,sidebar-manifest,bundle}.json` | 截图/自动检查与构建字节明细 |
