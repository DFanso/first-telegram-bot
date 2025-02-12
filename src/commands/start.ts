import TelegramBot from 'node-telegram-bot-api';
import { Command } from '../types';

export const startCommand: Command = {
  name: 'start',
  description: 'Start the bot',
  execute: async (msg: TelegramBot.Message, bot: TelegramBot) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, 'Welcome! Bot has started.');
  }
}; 