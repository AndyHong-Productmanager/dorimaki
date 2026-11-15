// /upgrade-and-restart command - Upgrade dorimaki to the latest version and restart the bot.
// Checks npm for a newer version, installs it globally, then spawns a new dorimaki process.
// The new process kills the old one on startup (dorimaki's single-instance lock).

import type { CommandContext } from './types.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getCurrentVersion, getRestartCommand, upgrade } from '../upgrade.js'
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
      content: `Upgraded dorimaki **v${currentVersion}** -> **v${newVersion}**. Restarting bot...`,
    })

    const restart = getRestartCommand(process.argv.slice(2))
    const child = spawn(restart.command, restart.args, {
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
    logger.debug('Started new background dorimaki')
  } catch (error) {
    logger.error('[UPGRADE] Failed:', error)
    await command.editReply({
      content: `Upgrade failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}
