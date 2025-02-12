import TelegramBot from 'node-telegram-bot-api';
import { Command } from '../types';
import path from 'path';
import fs from 'fs';
import { sendVideo } from '../utils/sendVideo';

export const startCommand: Command = {
  name: 'start',
  description: 'Start the bot',
  execute: async (msg: TelegramBot.Message, bot: TelegramBot) => {
    const chatId = msg.chat.id;

    // make a beautiful message
    const message = `
    Welcome to the bot! I'm a bot that can help you with your tasks.
    `;

    bot.sendMessage(chatId, message);
  }
};
