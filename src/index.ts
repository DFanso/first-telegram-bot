import TelegramBot from 'node-telegram-bot-api';
import { config } from './config';
import { handleMessage } from './handlers/messageHandler';

const bot = new TelegramBot(config.token, { polling: true });

bot.on('message', async (msg) => {
  try {
    await handleMessage(msg, bot);
  } catch (error) {
    console.error('Error handling message:', error);
  }
});

console.log('Bot is running...');
