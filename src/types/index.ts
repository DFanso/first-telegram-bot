import TelegramBot from "node-telegram-bot-api";

export interface Command {
  name: string;
  description: string;
  execute: (msg: TelegramBot.Message, bot: TelegramBot) => Promise<void>;
}

export interface BotConfig {
  token: string;
} 