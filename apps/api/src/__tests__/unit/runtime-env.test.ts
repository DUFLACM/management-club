import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRuntimeEnvironment } from '@acm/db'

const directories: string[] = []

function createWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-runtime-env-'))
  directories.push(root)
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: [apps/*]\n')
  for (const app of ['api', 'worker']) fs.mkdirSync(path.join(root, 'apps', app), { recursive: true })
  return root
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('工作区运行环境', () => {
  it('API 与 Worker 子目录读取根 .env，并共用同一绝对附件目录', () => {
    const root = createWorkspace()
    fs.writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgresql://acm@localhost/acm_club\nAUTH_DEV_SIMULATOR=true\nSTORAGE_LOCAL_DIR=./storage\n')
    const api: NodeJS.ProcessEnv = {}
    const worker: NodeJS.ProcessEnv = {}
    loadRuntimeEnvironment(path.join(root, 'apps', 'api'), api)
    loadRuntimeEnvironment(path.join(root, 'apps', 'worker'), worker)
    expect(api.DATABASE_URL).toBe('postgresql://acm@localhost/acm_club')
    expect(api.AUTH_DEV_SIMULATOR).toBe('true')
    expect(worker).toEqual(api)
    expect(api.STORAGE_LOCAL_DIR).toBe(path.join(root, 'storage'))
  })

  it('保留显式注入的生产配置和附件目录', () => {
    const root = createWorkspace()
    fs.writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgresql://demo\nNODE_ENV=development\nAUTH_DEV_SIMULATOR=true\nSTORAGE_LOCAL_DIR=./storage\n')
    const env: NodeJS.ProcessEnv = { DATABASE_URL: 'postgresql://production', NODE_ENV: 'production', AUTH_DEV_SIMULATOR: 'false', STORAGE_LOCAL_DIR: '/srv/acm/private-storage' }
    loadRuntimeEnvironment(path.join(root, 'apps', 'worker'), env)
    expect(env).toMatchObject({ DATABASE_URL: 'postgresql://production', NODE_ENV: 'production', AUTH_DEV_SIMULATOR: 'false', STORAGE_LOCAL_DIR: '/srv/acm/private-storage' })
  })

  it('无 .env 时在工作区边界停止，默认附件目录仍指向根目录', () => {
    const root = createWorkspace()
    const env: NodeJS.ProcessEnv = {}
    loadRuntimeEnvironment(path.join(root, 'apps', 'api'), env)
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.STORAGE_LOCAL_DIR).toBe(path.join(root, 'storage'))
  })

  it('支持指定 dotenv 文件，并相对该配置文件定位附件目录', () => {
    const root = createWorkspace()
    const configuration = path.join(root, 'configuration')
    fs.mkdirSync(configuration)
    fs.writeFileSync(path.join(configuration, 'worker.env'), 'DATABASE_URL=postgresql://custom\nSTORAGE_LOCAL_DIR=./uploads\n')
    const env: NodeJS.ProcessEnv = { DOTENV_CONFIG_PATH: '../../configuration/worker.env' }
    loadRuntimeEnvironment(path.join(root, 'apps', 'worker'), env)
    expect(env.DATABASE_URL).toBe('postgresql://custom')
    expect(env.STORAGE_LOCAL_DIR).toBe(path.join(configuration, 'uploads'))
  })
})
