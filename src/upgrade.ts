// Dorimaki self-upgrade utilities.
// Detects the package manager used to install dorimaki, checks npm for newer versions,
// and runs the global upgrade command. Used by both CLI `dorimaki upgrade` and
// the Discord `/upgrade-and-restart` command, plus background auto-upgrade on startup.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createLogger, LogPrefix } from './logger.js'
import { execAsync } from './worktrees.js'

const logger = createLogger(LogPrefix.CLI)

type Pm = 'bun' | 'pnpm' | 'npm'

// Detects which package manager globally installed dorimaki, used to run the
// correct `<pm> i -g dorimaki@latest` upgrade command.
//
// Detection order:
// 1. npm_config_user_agent — set by npx/bunx/pnpm dlx, reliable for those cases
// 2. Realpath of the running script — resolve symlinks and check if the path
//    lives under a known PM global directory (e.g. ~/.bun, ~/Library/pnpm,
//    /usr/local/lib/node_modules). Inspired by sindresorhus/global-directory.
// 3. process.versions.bun — if the runtime itself is Bun, likely bun ecosystem
// 4. Default to npm — safest fallback since npm is the most common global installer
export function detectPm(): Pm {
  const ua = process.env.npm_config_user_agent
  if (ua?.startsWith('bun/')) {
    return 'bun'
  }
  if (ua?.startsWith('pnpm/')) {
    return 'pnpm'
  }
  if (ua?.startsWith('npm/')) {
    return 'npm'
  }

  const scriptPath = resolveScriptRealpath()
  if (scriptPath) {
    const p = scriptPath.toLowerCase()
    // bun global installs live under ~/.bun or $BUN_INSTALL
    if (p.includes('.bun/') || p.includes('/bun/install/')) {
      return 'bun'
    }
    // pnpm global installs live under ~/Library/pnpm, ~/.local/share/pnpm, or $PNPM_HOME
    if (p.includes('/pnpm/')) {
      return 'pnpm'
    }
    // npm global installs typically live under lib/node_modules/dorimaki without
    // any pnpm or bun path segments, so if we reach here it's likely npm
  }

  if (process.versions.bun) {
    return 'bun'
  }

  return 'npm'
}

function resolveScriptRealpath(): string | null {
  try {
    const script = process.argv[1]
    if (!script) {
      return null
    }
    return fs.realpathSync(script)
  } catch {
    return null
  }
}

export function getCurrentVersion(): string {
  const require = createRequire(import.meta.url)
  const pkg = require('../package.json') as { version: string }
  return pkg.version
}

export async function getLatestNpmVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/dorimaki/latest', {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      return null
    }
    const data = (await res.json()) as { version: string } | null
    return data?.version ?? null
  } catch {
    return null
  }
}

// dorimaki is not published to npm; it runs from a git checkout whose committed
// dist/ is the shipped build. Returns the checkout root, or null for npm installs.
function getGitCheckoutDir(): string | null {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  return fs.existsSync(path.join(dir, '.git')) ? dir : null
}

function readPackageVersion(dir: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }
  return pkg.version
}

async function upgradeFromGit(dir: string): Promise<string | null> {
  const git = (args: string[]) =>
    execAsync({ command: 'git', args }, { cwd: dir, timeout: 120_000 }).then((r) => r.stdout.trim())
  await git(['fetch', '--quiet'])
  const head = await git(['rev-parse', 'HEAD'])
  const upstream = await git(['rev-parse', '@{u}'])
  if (head === upstream) {
    return null
  }
  logger.log(`Upgrading dorimaki checkout ${dir} with git pull --ff-only...`)
  await git(['pull', '--ff-only', '--quiet'])
  const sha = await git(['rev-parse', '--short', 'HEAD'])
  return `${readPackageVersion(dir)} (${sha})`
}

// Command that restarts the bot with the same entry script, instead of a bare
// `dorimaki` that only exists on PATH for global npm installs.
export function getRestartCommand(args: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [process.argv[1]!, ...args] }
}

// Returns the new version string if upgraded, null if already up to date.
export async function upgrade(): Promise<string | null> {
  const gitDir = getGitCheckoutDir()
  if (gitDir) {
    return upgradeFromGit(gitDir)
  }
  const current = getCurrentVersion()
  const latest = await getLatestNpmVersion()
  if (!latest) {
    throw new Error('Failed to check latest version from npm')
  }
  if (current === latest) {
    return null
  }

  const pm = detectPm()
  logger.log(`Upgrading dorimaki from v${current} to v${latest} using ${pm}...`)
  await execAsync(`${pm} i -g dorimaki@latest`, { timeout: 120_000 })

  return latest
}

// Fire-and-forget background upgrade check on bot startup.
// Only upgrades if a newer version is available. Errors are silently ignored.
export async function backgroundUpgradeDorimaki(): Promise<void> {
  // A git checkout is updated only on request; an npm package with the same
  // name must never be installed over it.
  if (getGitCheckoutDir()) {
    return
  }
  try {
    const current = getCurrentVersion()
    const latest = await getLatestNpmVersion()
    if (!latest || current === latest) {
      return
    }

    const pm = detectPm()
    logger.debug(`Background dorimaki upgrade started: v${current} -> v${latest}`)
    await execAsync(`${pm} i -g dorimaki@latest`, { timeout: 120_000 })
    logger.debug(`Background dorimaki upgrade completed: v${latest}`)
  } catch {
    // silently ignored, non-critical
  }
}
