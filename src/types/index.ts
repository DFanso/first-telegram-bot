import TelegramBot from "node-telegram-bot-api";

export interface Command {
  name: string;
  description: string;
  execute: (msg: TelegramBot.Message, bot: TelegramBot) => Promise<void>;
}

export interface BotConfig {
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly LOCAL_API_URL: string;
  readonly localApiServer: boolean;
  readonly QBITTORRENT_HOST: string;
  readonly QBITTORRENT_PORT: number;
  readonly QBITTORRENT_USERNAME: string;
  readonly QBITTORRENT_PASSWORD: string;
  readonly QBITTORRENT_DOWNLOAD_PATH: string;
} 