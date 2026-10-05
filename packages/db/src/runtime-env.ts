import fs from 'node:fs'
import path from 'node:path'
import { config as loadDotenv } from 'dotenv'

/** pnpm 在包目录启动进程：向上定位仓库 .env，并让 API/Worker 共用附件目录。 */
export function loadRuntimeEnvironment(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  let directory = path.resolve(cwd)
  let envPath: string | undefined
  let workspaceDirectory = directory
  const injectedStorage = env.STORAGE_LOCAL_DIR

  if (env.DOTENV_CONFIG_PATH) {
    envPath = path.resolve(directory, env.DOTENV_CONFIG_PATH)
    workspaceDirectory = path.dirname(envPath)
  } else {
    while (true) {
      const candidate = path.join(directory, '.env')
      if (fs.existsSync(candidate)) {
        envPath = candidate
        workspaceDirectory = directory
        break
      }
      // 不向工作区之外搜索，避免误读父目录的其他项目配置。
      if (fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
        workspaceDirectory = directory
        break
      }
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  if (envPath) loadDotenv({ path: envPath, processEnv: env, override: false, quiet: true })
  const storageDirectory = env.STORAGE_LOCAL_DIR ?? './storage'
  env.STORAGE_LOCAL_DIR = path.resolve(injectedStorage ? cwd : workspaceDirectory, storageDirectory)
}
