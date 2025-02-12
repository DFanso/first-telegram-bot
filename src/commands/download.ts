import TelegramBot from 'node-telegram-bot-api';
import { Command } from '../types';
import { sendVideo } from '../utils/sendVideo';

export const downloadCommand: Command = {
    name: 'download',
    description: 'Download and send a video from URL',
    execute: async (msg: TelegramBot.Message, bot: TelegramBot) => {
        const chatId = msg.chat.id;
        const url = msg.text?.split(' ')[1];

        if (!url) {
            await bot.sendMessage(
                chatId, 
                '⚠️ Please provide a video URL.\n' +
                'Usage: `/download <url>`\n\n' +
                'Example:\n' +
                '`/download https://example.com/video.mp4`', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        try {
            // Validate URL
            new URL(url);

            await bot.sendMessage(chatId, '🔍 Checking video URL...');

            // Send the video using our existing sendVideo utility
            await sendVideo(bot, chatId, url, false);

        } catch (error) {
            if (error instanceof TypeError) {
                await bot.sendMessage(chatId, '❌ Invalid URL provided. Please provide a valid video URL.');
            } else {
                console.error('Error downloading video:', error);
                await bot.sendMessage(chatId, '❌ Failed to download and process the video. Please try again later.');
            }
        }
    }
}; 