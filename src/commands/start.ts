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
    Welcome to the bot!
    I'm a bot that can help you with your tasks.
    `;

    // send an image
    const image = 'https://letsenhance.io/static/73136da51c245e80edc6ccfe44888a99/1015f/MainBefore.jpg';
    await bot.sendPhoto(chatId, image);
    await bot.sendMessage(chatId, message);

    // send a video
    await sendVideo(bot, chatId, path.join(__dirname, '../../assets/video.mp4'), true);
    await sendVideo(bot, chatId, 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', false);

  }
}; 