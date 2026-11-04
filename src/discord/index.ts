import { Client, GatewayIntentBits } from "discord.js";
import type { BotHandlers, Config, DiscordPort } from "../contracts";
import { connectClient } from "./transport";

export async function connectDiscord(config: Config, handlers: BotHandlers): Promise<DiscordPort> {
  return connectClient(new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [], repliedUser: false },
  }), config, handlers);
}
