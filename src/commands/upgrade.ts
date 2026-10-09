// /upgrade-and-restart command - Upgrade dori to the latest version and restart the bot.
// Checks npm for a newer version, installs it globally, then spawns a new dori process.
// The new process kills the old one on startup (dori's single-instance lock).

import type { CommandContext } from './types.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getCurrentVersion, upgrade } from '../upgrade.js'
import { spawn } from 'node:child_process'

const logger = createLogger(LogPrefix.CLI)

export async function handleUpgradeAndRestartCommand({
  command,
}: CommandContext): Promise<void> {
  await command.deferReply()

  logger.log('[UPGRADE] /upgrade-and-restart triggered')

  try {
    const currentVersion = getCurrentVersion()
    const newVersion = await upgrade()

    if (!newVersion) {
      await command.editReply({
        content: `Already on latest version: **v${currentVersion}**`,
      })
      return
    }

    await command.editReply({
      content: `Upgraded dori **v${currentVersion}** -> **v${newVersion}**. Restarting bot...`,
    })

    // Spawning bare `dori` works even if the user originally ran via npx/bunx:
    // `npm i -g dori@latest` creates a global bin link, and npx resolves
    // local -> global -> cache -> registry, so it prefers the global install.
    // bunx shares the same global cache, so it also picks up the new version.
    const child = spawn('dori', process.argv.slice(2), {
      shell: true,
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
    logger.debug('Started new background dori')
  } catch (error) {
    logger.error('[UPGRADE] Failed:', error)
    await command.editReply({
      content: `Upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}
