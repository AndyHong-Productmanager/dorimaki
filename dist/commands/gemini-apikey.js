// Audio API key button, slash command, and modal handlers.
// Used for both transcription and speech generation — same OpenAI/Gemini keys.
// Auto-detects provider from key prefix: sk-* = OpenAI, otherwise Gemini.
import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, } from 'discord.js';
import { setGeminiApiKey, setOpenAIApiKey } from '../database.js';
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js';
const AUDIO_API_KEY_REQUEST_TTL_MS = 60 * 60 * 1000;
const pendingAudioApiKeyRequests = new Map();
function resolvePendingAudioApiKeyRequest({ requestId, result, }) {
    if (!requestId)
        return false;
    const pending = pendingAudioApiKeyRequests.get(requestId);
    if (!pending)
        return false;
    clearTimeout(pending.timeout);
    pendingAudioApiKeyRequests.delete(requestId);
    pending.resolve(result);
    return true;
}
function buildTranscriptionApiKeyModal({ appId, requestId, }) {
    const context = requestId ? `${appId}:${requestId}` : appId;
    const modal = new ModalBuilder()
        .setCustomId(`transcription_apikey_modal:${context}`)
        .setTitle('Audio API Key');
    const apiKeyInput = new TextInputBuilder()
        .setCustomId('apikey')
        .setLabel('OpenAI or Gemini API Key')
        .setPlaceholder('sk-... or AIza...')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    const actionRow = new ActionRowBuilder().addComponents(apiKeyInput);
    modal.addComponents(actionRow);
    return modal;
}
/**
 * Show a "Set API Key" button in a Discord thread.
 * Reusable for both transcription and TTS — both use the same stored keys.
 * The button opens a modal where the user can enter an OpenAI or Gemini key.
 */
export async function showApiKeyRequiredButton({ thread, appId, message, requestId, }) {
    const context = requestId ? `${appId}:${requestId}` : appId;
    const button = new ButtonBuilder()
        .setCustomId(`transcription_apikey:${context}`)
        .setLabel('Set API Key')
        .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(button);
    await thread.send({
        content: message || 'An API key (OpenAI or Gemini) is required. Set one to continue.',
        components: [row],
        flags: SILENT_MESSAGE_FLAGS,
    });
}
export async function requestAudioApiKey({ thread, appId, message, }) {
    const requestId = crypto.randomBytes(8).toString('hex');
    const result = new Promise((resolve) => {
        const timeout = setTimeout(() => {
            pendingAudioApiKeyRequests.delete(requestId);
            resolve(null);
        }, AUDIO_API_KEY_REQUEST_TTL_MS);
        pendingAudioApiKeyRequests.set(requestId, { resolve, timeout });
    });
    await showApiKeyRequiredButton({ thread, appId, message, requestId });
    return result;
}
export async function handleTranscriptionApiKeyButton(interaction) {
    if (!interaction.customId.startsWith('transcription_apikey:'))
        return;
    const [appId, requestId] = interaction.customId
        .slice('transcription_apikey:'.length)
        .trim()
        .split(':');
    if (!appId) {
        await interaction.reply({
            content: 'Missing app id for API key setup.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    await interaction.showModal(buildTranscriptionApiKeyModal({ appId, requestId }));
}
export async function handleTranscriptionApiKeyCommand({ interaction, appId, }) {
    await interaction.showModal(buildTranscriptionApiKeyModal({ appId }));
}
export async function handleTranscriptionApiKeyModalSubmit(interaction) {
    if (!interaction.customId.startsWith('transcription_apikey_modal:'))
        return;
    const [appId, requestId] = interaction.customId
        .slice('transcription_apikey_modal:'.length)
        .trim()
        .split(':');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!appId) {
        await interaction.editReply({
            content: 'Missing app id for API key setup.',
        });
        return;
    }
    const apiKey = interaction.fields.getTextInputValue('apikey').trim();
    if (!apiKey) {
        await interaction.editReply({
            content: 'API key is required.',
        });
        return;
    }
    const provider = apiKey.startsWith('sk-') ? 'openai' : 'gemini';
    if (provider === 'openai') {
        await setOpenAIApiKey(appId, apiKey);
    }
    else {
        await setGeminiApiKey(appId, apiKey);
    }
    const resumed = resolvePendingAudioApiKeyRequest({
        requestId,
        result: { apiKey, provider },
    });
    const providerName = provider === 'openai' ? 'OpenAI' : 'Gemini';
    await interaction.editReply({
        content: resumed
            ? `${providerName} API key saved. Retrying the original voice message.`
            : `${providerName} API key saved. Voice transcription and speech generation are now enabled.`,
    });
}
