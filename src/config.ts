import dotenv from 'dotenv';
import { BotConfig } from './types';

dotenv.config();

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is not defined');
}

export const config: BotConfig = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  LOCAL_API_URL: process.env.LOCAL_API_URL || 'http://localhost:8081',
  localApiServer: true,
  QBITTORRENT_HOST: process.env.QBITTORRENT_HOST || 'localhost',
  QBITTORRENT_PORT: Number(process.env.QBITTORRENT_PORT) || 8080,
  QBITTORRENT_USERNAME: process.env.QBITTORRENT_USERNAME || 'admin',
  QBITTORRENT_PASSWORD: process.env.QBITTORRENT_PASSWORD || 'adminadmin',
  QBITTORRENT_DOWNLOAD_PATH: process.env.QBITTORRENT_DOWNLOAD_PATH || './downloads',
  QBITTORRENT_NETWORK_PATH: process.env.QBITTORRENT_NETWORK_PATH || 'G:\\Download'
}; 