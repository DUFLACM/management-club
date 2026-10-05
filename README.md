# 大连外国语大学 ACM 算法协会积分管理系统

活动、出勤、积分与赛事管理系统。技术栈为 **NestJS + PostgreSQL（Prisma）+ React/Vite + shadcn/ui + Tailwind CSS**，独立 Worker 处理平台同步，包含校内 **Hydro OJ Bridge 插件**（`packages/hydro-bridge`）。

> 业务规则依据 `docs/` 九份协会制度 PDF，摘录见 `docs/pdf-text/`；设计方案见 `docs/scheme/`。当前 17 个业务面板已实现，其中 16 个至少部分接入业务 API；规则参数页展示本地制度默认参考，不读取数据库生效规则版本。

## 快速开始（本地开发，默认真实校园 CAS）

前置为 Node ≥22.14、pnpm ≥12、PostgreSQL 16+（本机或 Docker）。

```bash
# 1. 本地 PostgreSQL；已有实例可跳过
./scripts/dev-postgres.sh          # Homebrew postgresql@18，127.0.0.1:5433
# Docker 替代：docker compose up -d

# 2. 依赖与开发数据库
pnpm install
cp .env.example .env               # 默认 AUTH_DEV_SIMULATOR=false，使用真实学校 CAS
pnpm db:migrate
pnpm db:seed                       # 仅本地开发演示数据；不是真实社员、地点或赛事结果

# 3. 三个终端启动，或 pnpm dev 并行
pnpm dev:api                       # http://127.0.0.1:8080
pnpm dev:web                       # http://localhost:5173，/api 代理到 API
pnpm dev:worker
```

平台同步任务由 `dev:worker` 执行。只启动 API 和 web 时，任务会一直排队且尝试次数为 0；管理同步页的「刷新状态」只重新读取任务状态。建议使用 `pnpm dev` 一起启动三个进程。

若 Worker 报「解析到禁止访问的地址」，先检查代理是否将平台域名解析到 `198.18.*` fake-IP。可在 `.env` 中配置 `PLATFORM_NOWCODER_ADDRESS`、`PLATFORM_CODEFORCES_ADDRESS`、`PLATFORM_ATCODER_ADDRESS` 为经 HTTPS 公共 DNS 核验的真实公网 IP，然后重启 Worker。连接仍校验原域名的 TLS 证书并拒绝私网地址；CDN IP 变化后须重新核验，正常 DNS 环境留空。

打开 [本地登录页](http://localhost:5173/login)，选择「使用校园 CAS 登录」将跳转学校 `https://cas.dlufl.edu.cn/cas/login`。数字大外密码在学校页面输入，本站不收集该密码。当前已配置真实模式，学校登录页返回 HTTP 200，项目 CAS 客户端调用真实校验接口收到合成无效票 INVALID_TICKET，完成只读验证；**尚未证明有效校园账号登录成功，也未完成校方生产联调**。

本机当前已实际 deploy 全部 **7 个迁移**，`prisma migrate status` 显示 schema up to date；API 已按 `AUTH_DEV_SIMULATOR=false` 的真实 CAS 配置重启，`GET /api/v1/auth/csrf` 返回 200。它们证明本地迁移和匿名认证入口可用，不等同于有效校园票据成功。

本地精确回调为 `http://localhost:5173/api/v1/auth/cas/callback?flow=<random>`，每次 flow 独立且需要浏览器绑定。校方 service 白名单、成功票据属性契约仍需核验；生产应使用同域 HTTPS 域名。CAS 返回的 `id_number` 按 1–64 位 `[A-Za-z0-9._-]` opaque 校园编号原样保存，不按长度推断学生或教职工。普通新学生身份不能绕过协会邀请注册；受控 CLI 预登记的教职工可从登录入口首次绑定稳定 CAS subject，不消耗学生邀请。

- 成员工作台 `/app`：概览 / 活动 / 签到与出勤 / 竞赛与贡献 / 积分 / 榜单 / 我的。
- 管理工作台 `/admin`：概览 / 成员 / 活动与地点及现场码 / 赛事 / 积分审核 / 规则 / 邀请 / 同步 / 审计 / 设置。首页「管理员登录」进入 `/admin/login` 的独立本地管理员认证；开发 seed 校园编号 `202600001` 含 presidium 角色。
- 未登录入口不展开私人工作台侧栏；手机三页使用统一单行品牌头与主面板；首页 CAS 一次点击直达学校，登录/注册返回与 logo 都能回首页，注册提供真实相机扫码。

## 线上参赛现状

当前平台活动详情可进行社团报名、申请远程（pending）和跳转平台报名；竞赛页的平台记录可人工审核绑定与申请刷新。后端已有远程审批 API，管理前端尚缺专门审批操作/队列；手动账本与通用审核已存在。

完整线上赛事闭环仍有内部软件待办：纯线上发布模式（当前仍要求签到策略）、实时指定赛事/备案目录、正式赛事报名组队 API 与专页、CF 提交证据与完整成绩入库、完赛材料/有效参赛/晋级资格/自动积分链，以及 Worker Hydro pull。`networkQualifierScore` 仅有纯函数与单测，尚未被 API /Worker 调用。这些缺口需要开发，不能全部归因于校方或 R01–R13。详细边界见状态报告与验收报告 §8。

## 显式启用本地模拟与自动化验证

模拟器仅供开发与测试。默认保持关闭；需要演示登录或重放截图时，在本地 API 进程显式覆盖环境变量并重启：

```bash
NODE_ENV=development AUTH_DEV_SIMULATOR=true pnpm dev:api
```

此时 `/login` 会进入明示「模拟模式 · 开发专用」的模拟 CAS 页。校园编号 `202600001`，口令使用本地 `.env` 的 `AUTH_DEV_SIMULATOR_PASSWORD`。模拟成功与真实校园成功是不同验证档位；`NODE_ENV=production` 禁止开启模拟器。集成测试 setup 独立设置测试模拟环境，不依赖根 `.env` 的认证模式，无需切换运行中的真实 CAS 配置。

```bash
pnpm build                       # 7 个包构建
pnpm test                        # 161：scoring-core 57 + Hydro Bridge 60 + API 25 + web 19
pnpm test:integration             # 51 项，真实 PG；重建专用 acm_club_test 库
pnpm run typecheck
pnpm db:migrate:deploy            # 生产迁移
pnpm cli                         # 管理 CLI
```

业务基线截图需在本地临时启动模拟 API，并对准备 fixture 和截图进程也显式启用模拟；以下是复跑说明，不修改根 `.env` 的真实默认。API /web 分别运行于 8080 /5173，模拟验收结束后重启普通 `pnpm dev:api` 恢复真实模式。

```bash
# API 终端：仅本地显式模拟
NODE_ENV=development AUTH_DEV_SIMULATOR=true pnpm dev:api
# 另一终端：开发演示 fixture 与业务截图
AUTH_DEV_SIMULATOR=true pnpm --filter @acm/db seed:ui
AUTH_DEV_SIMULATOR=true pnpm screenshot
```

新版公开入口与扫码验收在真实 CAS 配置下复跑；平板脚本独立 mock 会话仅验布局。摄像头验收依赖本机 `ffmpeg` 生成测试视频，仍不是物理手机验收。

```bash
pnpm --filter @acm/web exec node scripts/entry-screenshot.mjs
pnpm --filter @acm/web exec node scripts/invitation-camera-check.mjs
pnpm --filter @acm/web exec node scripts/sidebar-layout-check.mjs
```

业务基线为 **85 张 /184 项检查**（真实本地 HTTP/PG 的开发演示 fixture）；最新真实模式公开/管理员入口为 **45 张 /274 项**，Chrome 测试摄像头真实解码与拒绝路径为 **2 张 /10 项**，另有 **2 张 /14 项**隔离 mock 会话的平板侧栏纯布局验收，合计 **134 张 /482 项自动检查**，四组范围分开记录。管理员账号/验证码第二步截图使用隔离 UI fixture，未提交凭据。明细见 `docs/ui-preview/{manifest,entry-manifest,camera-manifest,sidebar-manifest}.json` 与验收报告附录；真实学校有效票成功与物理手机验收仍未完成。独立 lint 规则尚未配置，根 `lint` 的 `--if-present` 不构成 lint 通过证据。成员概览必需静态 JS gzip 为 176,130 B（172.00 KiB），CSS 为 11,375 B（11.11 KiB）；学校 logo 原始 PNG 另计 32,000 B（31.25 KiB），不计入 JS/CSS 合计。明细见 `docs/ui-preview/bundle.json` 和 `apps/web/src/BUILD_NOTES.md`；这些构建值不能替代运行性能。

首位管理员不需要邀请码，也不需要先建立 CAS 成员账号。在受控服务器执行 `init-local-admin`，它创建独立的 system principal，并同时授予 `presidium + system_admin`；随机初始密码和管理入口密语只在标准输出显示一次，数据库只保存慢哈希。随后从首页「管理员登录」进入密语、用户名/密码和服务端单次验证码两阶段认证：

```bash
pnpm cli init-local-admin --username club-admin --name 协会管理员
pnpm cli register-staff --staff-no T001 --name 指导教师 --title 指导教师 --role advisor
pnpm cli init-admin --campus-id 202600001 --role presidium
pnpm cli init-rule-version       # R01 等未决参数保持 pending，阻塞受影响正式结算
pnpm cli rotate-secret --key hydro-push-<instanceId>
pnpm cli cas-status              # 检查真实/模拟模式与 CAS 配置
```

`register-staff` 只做受控教职工预登记；首次校园 CAS 登录仍须由学校成功验票，并同时匹配预登记 `staffNo` 与姓名后才绑定稳定 subject。`init-admin` 只给已经存在的学生或教职工主体追加角色，`--student-no` 仅保留为兼容别名。入口密语可由已登录的本地管理员在设置页用当前本地密码轮换；轮换会撤销尚未使用的 gate，不回显明文。

## 仓库结构

```text
apps/api              NestJS API（/api/v1；认证/注册/活动/地点/出勤/积分/设置）
apps/worker           PostgreSQL jobs + lease；同步/导入/头像/冻结/幂等收据
apps/web              成员 /app、管理 /admin；section 按需加载
packages/db           Prisma schema、迁移、种子（schema 在根 prisma/）
packages/scoring-core 积分纯函数与 R01–R13 显式阻塞
packages/integrations 牛客/CF/AtCoder 适配器与 Hydro 协议
packages/hydro-bridge Hydro outbox、签名 webhook、只读桥接路由
prisma/               schema.prisma、7 个迁移与自定义约束
scripts/              本地数据库工具
docs/                 制度原文、方案、部署、状态、验收与截图证据
```

## 部署与验证边界

同域 HTTPS 反向代理将 `/api/v1` 交给 API，静态资源交给 web，`/app /admin /admin/login /login /register` 交给 SPA 入口。CAS 回调必须由后端处理，不能被 SPA fallback 截获。配置、白名单与备份恢复见 `docs/deploy.md`；实现分档见 `docs/implementation-status.md`；实测与剩余条件见 `docs/acceptance-report.md`。

仍需校方 CAS 成功属性与 service 白名单、学生与教职工有效账号的真实验票/属性契约、真实地点采样认证、Hydro/Mongo 实际环境、协会确认 R01–R13，以及真机浏览器、目标服务器压测与 RUM。构建体积与浏览器模拟视口不能替代这些验收。

## 安全边界

- 校园编号只取自已验真 CAS 响应，按 1–64 位 `[A-Za-z0-9._-]` 文本保留前导零；数据库 CHECK + UNIQUE 兜底，不用长度判断身份类型。
- 普通学生邀请原子兑换、最后名额并发限制；未知 CAS 身份不能绕过邀请。教职工仅能由受控预登记匹配后首次绑定；独立本地管理员不走 CAS 或邀请。
- 服务端 opaque 会话、HttpOnly Cookie、CSRF + Origin；注销/401 清理私人查询缓存。
- 现场 QR 绑定活动、地点版本、检查点与策略；共享码多人使用，本人检查点唯一，IN 码不能作 OUT。
- 地点认证与运行状态分离；创建/编辑/提交者按 principal 回避审核；停用/撤销即时失效。
- 平台出站使用白名单、SSRF 防护与共享限流；第三方故障不阻断签到。
- 账本 source_key 唯一，纠错为冲正加替代；R01–R13 维持显式 pending，不擅自解释制度。
