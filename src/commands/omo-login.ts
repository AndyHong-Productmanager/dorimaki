// /login for the omo engine: browser (OAuth) sign-in through omo's
// `login_start` RPC, rendered as one ephemeral Discord message.
//
// API keys are deliberately not accepted here; they are entered on the bot
// machine with the omo CLI so they never travel through Discord.
//
// CustomId patterns (hash keys the login state):
//   omo_login_provider:<hash>  provider select
//   omo_login_select:<hash>    a select dialog omo raised mid-login
//   omo_login_input:<hash>     button that opens the code/URL modal
//   omo_login_cancel:<hash>    cancel button
//   omo_login_modal:<hash>     code/URL modal submission

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js'
import crypto from 'node:crypto'

import { createLogger, LogPrefix } from '../logger.js'
import { listOmoOAuthProviders, startOmoLogin, type OmoLogin } from '../omo/login.js'
import { clearModelListCache } from '../session-handler/model-utils.js'

const logger = createLogger(LogPrefix.LOGIN)

const LOGIN_TTL_MS = 15 * 60 * 1000
const PROGRESS_RENDER_INTERVAL_MS = 1500

type EditableInteraction =
  | ChatInputCommandInteraction
  | StringSelectMenuInteraction
  | ButtonInteraction
  | ModalSubmitInteraction

type LoginState = {
  hash: string
  interaction: EditableInteraction
  providers: Map<string, string>
  providerId?: string
  login?: OmoLogin
  url?: string
  progress: string[]
  pendingSelect?: { requestId: string; title: string; options: string[] }
  pendingInput?: { requestId: string; title: string; placeholder: string | undefined }
  result?: { success: boolean; error: string | undefined }
  lastRender: number
  renderTimer?: NodeJS.Timeout
}

const logins = new Map<string, LoginState>()

function createState(interaction: EditableInteraction): LoginState {
  const hash = crypto.randomBytes(8).toString('hex')
  const state: LoginState = { hash, interaction, providers: new Map(), progress: [], lastRender: 0 }
  logins.set(hash, state)
  setTimeout(() => {
    const current = logins.get(hash)
    if (current && !current.result) void current.login?.cancel().catch(() => undefined)
    logins.delete(hash)
  }, LOGIN_TTL_MS).unref()
  return state
}

function stateFromCustomId(customId: string): LoginState | undefined {
  return logins.get(customId.slice(customId.indexOf(':') + 1))
}

function renderContent(state: LoginState): string {
  const name = state.providerId ? state.providers.get(state.providerId) ?? state.providerId : ''
  const lines = [`**omo login: ${name}**`]
  if (state.result) {
    lines.push(state.result.success
      ? `✅ Signed in to ${name}. Its models now show up in /model.`
      : `✗ Login failed: ${state.result.error ?? 'unknown error'}`)
    return lines.join('\n')
  }
  if (state.url) lines.push(`1. [Open the sign-in page](${state.url}) and finish signing in.`)
  if (state.pendingInput) {
    lines.push(
      `2. If the browser ends on a localhost page that does not load, copy the whole address from the address bar and press **Paste code / URL**.`,
    )
  }
  if (state.pendingSelect) lines.push(state.pendingSelect.title)
  for (const text of state.progress.slice(-3)) lines.push(`> ${text.slice(0, 300)}`)
  if (!state.url && !state.pendingSelect && state.progress.length === 0) lines.push('Starting login...')
  return lines.join('\n').slice(0, 2000)
}

function renderComponents(state: LoginState) {
  if (state.result) return []
  const rows: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = []
  if (state.pendingSelect) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`omo_login_select:${state.hash}`)
      .setPlaceholder('Choose an option')
      .addOptions(state.pendingSelect.options.slice(0, 25).map((option) => ({
        label: option.slice(0, 100),
        value: option.slice(0, 100),
      })))
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu))
  }
  const buttons: ButtonBuilder[] = []
  if (state.pendingInput) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`omo_login_input:${state.hash}`)
      .setLabel('Paste code / URL')
      .setStyle(ButtonStyle.Primary))
  }
  buttons.push(new ButtonBuilder()
    .setCustomId(`omo_login_cancel:${state.hash}`)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary))
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons))
  return rows
}

async function render(state: LoginState): Promise<void> {
  if (state.renderTimer) {
    clearTimeout(state.renderTimer)
    state.renderTimer = undefined
  }
  state.lastRender = Date.now()
  await state.interaction.editReply({ content: renderContent(state), components: renderComponents(state) })
    .catch((e) => logger.warn('[OMO LOGIN] failed to update login message:', e))
}

function scheduleProgressRender(state: LoginState): void {
  if (state.renderTimer) return
  const wait = Math.max(0, PROGRESS_RENDER_INTERVAL_MS - (Date.now() - state.lastRender))
  state.renderTimer = setTimeout(() => void render(state), wait)
}

export async function handleOmoLoginCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const providers = await listOmoOAuthProviders().catch((e: Error) => e)
  if (providers instanceof Error) {
    await interaction.editReply({ content: `Failed to load omo providers: ${providers.message}` })
    return
  }
  if (providers.length === 0) {
    await interaction.editReply({ content: 'omo reports no providers with browser sign-in.' })
    return
  }
  const state = createState(interaction)
  for (const provider of providers) state.providers.set(provider.id, provider.name)

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`omo_login_provider:${state.hash}`)
    .setPlaceholder('Select a provider to sign in')
    .addOptions(providers.slice(0, 25).map((provider) => ({
      label: `${provider.name}${provider.configured ? ' ✓' : ''}`.slice(0, 100),
      value: provider.id,
      description: provider.configured ? 'Signed in - select to add or refresh an account' : 'Not signed in',
    })))
  await interaction.editReply({
    content: [
      '**omo login**',
      'Select a provider to sign in with your browser.',
      'For API key providers, run `omo` on the bot machine and use its `/login` there, so keys never pass through Discord.',
    ].join('\n'),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  })
}

export async function handleOmoLoginSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const state = stateFromCustomId(interaction.customId)
  await interaction.deferUpdate()
  if (!state) {
    await interaction.editReply({ content: 'This login expired. Run /login again.', components: [] })
    return
  }
  state.interaction = interaction
  const value = interaction.values[0]
  if (!value) return

  if (interaction.customId.startsWith('omo_login_provider:')) {
    if (state.login) return
    state.providerId = value
    await render(state)
    try {
      state.login = await startOmoLogin({
        provider: value,
        onEvent: (event) => {
          switch (event.type) {
            case 'url':
              state.url = event.url
              void render(state)
              return
            case 'progress':
              if (event.text.trim()) state.progress.push(event.text.trim())
              scheduleProgressRender(state)
              return
            case 'select':
              state.pendingSelect = event
              void render(state)
              return
            case 'input':
              state.pendingInput = event
              void render(state)
              return
            case 'end':
              state.result = { success: event.success, error: event.error }
              state.pendingSelect = undefined
              state.pendingInput = undefined
              clearModelListCache()
              void render(state)
              return
          }
        },
      })
    } catch (e) {
      state.result = { success: false, error: e instanceof Error ? e.message : String(e) }
      await render(state)
    }
    return
  }

  const pending = state.pendingSelect
  if (!pending || !state.login) return
  state.pendingSelect = undefined
  await render(state)
  await state.login.answer(pending.requestId, value)
    .catch((e) => logger.warn('[OMO LOGIN] failed to answer select:', e))
}

export async function handleOmoLoginButton(interaction: ButtonInteraction): Promise<void> {
  const state = stateFromCustomId(interaction.customId)
  if (!state) {
    await interaction.reply({ content: 'This login expired. Run /login again.', flags: MessageFlags.Ephemeral })
    return
  }

  if (interaction.customId.startsWith('omo_login_input:')) {
    const pending = state.pendingInput
    if (!pending) {
      await interaction.deferUpdate()
      return
    }
    const input = new TextInputBuilder()
      .setCustomId('value')
      .setLabel('Code or redirect URL')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
    if (pending.placeholder) input.setPlaceholder(pending.placeholder.slice(0, 100))
    const modal = new ModalBuilder()
      .setCustomId(`omo_login_modal:${state.hash}`)
      .setTitle('omo login')
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
    await interaction.showModal(modal)
    return
  }

  await interaction.deferUpdate()
  state.interaction = interaction
  if (!state.login) {
    state.result = { success: false, error: 'Login cancelled' }
    await render(state)
    return
  }
  await state.login.cancel().catch((e) => logger.warn('[OMO LOGIN] cancel failed:', e))
}

export async function handleOmoLoginModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const state = stateFromCustomId(interaction.customId)
  if (!state) {
    await interaction.reply({ content: 'This login expired. Run /login again.', flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.deferUpdate()
  state.interaction = interaction
  const pending = state.pendingInput
  const value = interaction.fields.getTextInputValue('value').trim()
  if (!pending || !state.login || !value) return
  state.pendingInput = undefined
  state.progress.push('Code received, finishing sign-in...')
  await render(state)
  await state.login.answer(pending.requestId, value)
    .catch((e) => logger.warn('[OMO LOGIN] failed to submit code:', e))
}
