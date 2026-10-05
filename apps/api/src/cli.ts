import { createPrismaClient, loadRuntimeEnvironment, type PrismaClient } from '@acm/db'
import { loadEnv, isDevSimulatorEnabled } from './config/env.js'
import { newId, isValidCampusId } from './common/utils.js'
import { generateInitialAdminSecret, hashAdminSecret, normalizeAdminUsername } from './modules/auth/admin-auth.crypto.js'

/**
 * 管理 CLI（受控服务器初始化，非 Web 入口）：
 * - `node dist/cli.js init-local-admin --username admin`：创建独立本地管理员，初始密码/入口密语仅显示一次。
 * - `node dist/cli.js register-staff --staff-no T001 --name 指导教师`：预登记教职工，首次 CAS 登录绑定 subject。
 * - `node dist/cli.js init-admin --campus-id 202600001 --role presidium`：给已存在的学生/教职工追加角色。
 * - `node dist/cli.js init-rule-version`：写入规则版本 v1（默认参数，R01 保持 pending）。
 * - `node dist/cli.js rotate-secret <key>`：生成新密钥（打印一次，写 secret_references）。
 */

interface CliArgs {
  command: string
  studentNo?: string
  campusId?: string
  staffNo?: string
  kind?: string
  username?: string
  name?: string
  title?: string
  role?: string
  key?: string
}

function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv
  const args: CliArgs = { command: command ?? 'help' }
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.replace(/^--/, '')
    const v = rest[i + 1]
    if (k === 'student-no') args.studentNo = v
    else if (k === 'campus-id') args.campusId = v
    else if (k === 'staff-no') args.staffNo = v
    else if (k === 'kind') args.kind = v
    else if (k === 'username') args.username = v
    else if (k === 'name') args.name = v
    else if (k === 'title') args.title = v
    else if (k === 'role') args.role = v
    else if (k === 'key') args.key = v
  }
  return args
}

const ROLES = ['member', 'activity_manager', 'points_reviewer', 'presidium', 'advisor', 'system_admin']

async function main(): Promise<void> {
  loadRuntimeEnvironment()
  const env = loadEnv()
  const args = parseArgs(process.argv.slice(2))
  const db: PrismaClient = createPrismaClient(env.DATABASE_URL)
  try {
    switch (args.command) {
      case 'init-local-admin': {
        const username = normalizeAdminUsername(args.username)
        if (!username) throw new Error('--username 必须为 3–64 位小写字母、数字或 ._-')
        const displayName = args.name?.trim() || username
        if (displayName.length > 100) throw new Error('--name 不能超过 100 个字符')
        const initialPassword = generateInitialAdminSecret()
        const accessSecret = generateInitialAdminSecret()
        const [passwordHash, secretHash] = await Promise.all([
          hashAdminSecret(initialPassword),
          hashAdminSecret(accessSecret),
        ])
        const principalId = newId()
        const credentialId = newId()
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'init-local-admin'}, 0))`
          if (await tx.adminCredential.count() > 0) {
            throw new Error('本地管理员已初始化；本命令不会覆盖已有密码或密语')
          }
          if (await tx.adminAccessSecret.findUnique({ where: { key: 'primary' } })) {
            throw new Error('管理员入口密语已存在；拒绝静默覆盖')
          }
          await tx.principal.create({ data: { id: principalId, kind: 'system' } })
          await tx.adminCredential.create({
            data: { id: credentialId, principalId, username, displayName, passwordHash },
          })
          await tx.adminAccessSecret.create({ data: { key: 'primary', secretHash, version: 1 } })
          for (const role of ['presidium', 'system_admin']) {
            await tx.roleGrant.create({
              data: { id: newId(), principalId, role, grantedBy: principalId, grantedAt: new Date() },
            })
          }
          await tx.auditLog.create({
            data: {
              id: newId(), action: 'cli.init_local_admin', resourceType: 'admin_credential', resourceId: credentialId,
              summary: '初始化独立本地管理员，授予 presidium + system_admin',
            },
          })
        })
        console.log('✓ 本地管理员已创建（角色：presidium + system_admin）')
        console.log(`用户名: ${username}`)
        console.log(`初始密码（仅显示本次）: ${initialPassword}`)
        console.log(`入口密语（仅显示本次）: ${accessSecret}`)
        break
      }
      case 'register-staff': {
        const staffNo = args.staffNo
        const realName = args.name?.trim()
        const role = args.role ?? 'advisor'
        if (!staffNo || !isValidCampusId(staffNo)) throw new Error('--staff-no 必须为 1–64 位校园编号（字母、数字或 ._-）')
        if (!realName || realName.length > 100) throw new Error('--name 必填且不能超过 100 个字符')
        if (args.title && args.title.length > 100) throw new Error('--title 不能超过 100 个字符')
        if (!ROLES.includes(role)) throw new Error(`--role 必须是 ${ROLES.join('/')} 之一`)
        const principalId = newId()
        const profileId = newId()
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${staffNo}, 0))`
          const studentConflict = await tx.user.findUnique({ where: { studentNo: staffNo } })
          const staffConflict = await tx.staffProfile.findUnique({ where: { staffNo } })
          if (studentConflict) throw new Error(`校园编号 ${staffNo} 已属于学生主体，拒绝跨类型复用`)
          if (staffConflict) throw new Error(`教职工编号 ${staffNo} 已预登记`)
          await tx.principal.create({ data: { id: principalId, kind: 'staff' } })
          await tx.staffProfile.create({
            data: {
              id: profileId, principalId, staffNo, realName, title: args.title?.trim() || null,
              approvedSource: 'CLI 受控教职工预登记', status: 'active',
            },
          })
          await tx.roleGrant.create({ data: { id: newId(), principalId, role, grantedBy: principalId } })
          await tx.auditLog.create({
            data: {
              id: newId(), action: 'cli.register_staff', resourceType: 'staff_profile', resourceId: profileId,
              summary: `教职工预登记，角色 ${role}；等待首次 CAS 绑定`,
            },
          })
        })
        console.log(`✓ 已预登记教职工 ${staffNo}（${realName}），角色 ${role}；请使用校园 CAS 首次登录完成绑定`)
        break
      }
      case 'init-admin': {
        const campusId = args.campusId ?? args.studentNo
        if (!campusId || !isValidCampusId(campusId)) throw new Error('--campus-id 必须为 1–64 位校园编号（--student-no 仅作兼容别名）')
        const role = args.role ?? 'presidium'
        if (!ROLES.includes(role)) throw new Error(`--role 必须是 ${ROLES.join('/')} 之一`)
        const [user, staff] = await Promise.all([
          db.user.findUnique({ where: { studentNo: campusId } }),
          db.staffProfile.findUnique({ where: { staffNo: campusId } }),
        ])
        if (user && staff) throw new Error(`校园编号 ${campusId} 同时命中学生与教职工资料，拒绝自动选择`)
        const principalId = user?.principalId ?? staff?.principalId
        if (!principalId) throw new Error(`校园编号 ${campusId} 尚未注册或预登记`)
        const existingGrant = await db.roleGrant.findFirst({ where: { principalId, role, revokedAt: null } })
        if (existingGrant) {
          console.log(`✓ ${campusId} 已拥有 ${role}，无需重复授予`)
          break
        }
        const grant = await db.roleGrant.create({
          data: { id: newId(), principalId, role, grantedBy: principalId, grantedAt: new Date() },
        })
        await db.auditLog.create({
          data: {
            id: newId(),
            actorPrincipalId: principalId,
            action: 'cli.init_admin',
            resourceType: 'role_grant',
            resourceId: grant.id,
            summary: `CLI 授予管理员角色 ${role}（校园编号 ${campusId}）`,
          },
        })
        console.log(`✓ 已为 ${campusId} 授予 ${role}`)
        break
      }
      case 'init-rule-version': {
        const { defaultRuleParams } = await import('@acm/scoring-core')
        const count = await db.ruleVersion.count()
        const rv = await db.ruleVersion.create({
          data: {
            id: newId(),
            version: count + 1,
            source: 'CLI 初始化（依据 docs/ 九份 PDF；R01-R13 未决项见 pending_items）',
            params: defaultRuleParams() as never,
            pendingItems: { open: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12', 'R13'] } as never,
            status: 'published',
            effectiveFrom: new Date(),
          },
        })
        console.log(`✓ 规则版本 v${rv.version} 已创建并发布（monthlyRounding=pending：正式月结算被阻塞直至 R01 确认）`)
        break
      }
      case 'rotate-secret': {
        if (!args.key) throw new Error('--key 必填（如 hydro-push-<instanceId>）')
        const secret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
        const existing = await db.secretReference.findUnique({ where: { key: args.key } })
        if (existing) {
          await db.secretReference.update({ where: { key: args.key }, data: { secretEnc: secret, version: { increment: 1 }, lastRotated: new Date() } })
        } else {
          await db.secretReference.create({ data: { id: newId(), key: args.key, secretEnc: secret } })
        }
        console.log(`✓ 密钥 ${args.key} 已写入（版本 ${existing ? existing.version + 1 : 1}）。以下值仅本次显示：`)
        console.log(secret)
        break
      }
      case 'cas-status': {
        console.log(`CAS_BASE_URL=${env.CAS_BASE_URL}`)
        console.log(`AUTH_DEV_SIMULATOR=${env.AUTH_DEV_SIMULATOR}（production=${env.NODE_ENV === 'production'}）`)
        console.log(isDevSimulatorEnabled(env) ? '当前为开发模拟模式：模拟登录页 /api/v1/dev-cas/login；生产环境强制禁用' : '模拟器未启用')
        break
      }
      default:
        console.log(`用法：
  node dist/cli.js init-local-admin --username <用户名> [--name <显示名>]
  node dist/cli.js register-staff --staff-no <教职工校园编号> --name <姓名> [--title <职称>] [--role advisor]
  node dist/cli.js init-admin --campus-id <已有学生或教职工校园编号> --role <presidium|system_admin|...>
  node dist/cli.js init-rule-version
  node dist/cli.js rotate-secret --key <key>
  node dist/cli.js cas-status`)
    }
  } finally {
    await db.$disconnect()
  }
}

void main()
