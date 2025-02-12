import dotenv from 'dotenv';
import { BotConfig } from '../types';

dotenv.config();

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is not defined');
}

export const config: BotConfig = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  baseApiUrl: process.env.LOCAL_API_URL || 'http://localhost:8081',
  localApiServer: true
}; 