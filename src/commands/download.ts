import TelegramBot from 'node-telegram-bot-api';
import { Command } from '../types';
import { sendVideo } from '../utils/sendVideo';

// Store user states
const userStates = new Map<number, 'waiting_for_url'>();

// Handler for URL input
export const handleDownloadInput = async (msg: TelegramBot.Message, bot: TelegramBot): Promise<boolean> => {
    const chatId = msg.chat.id;
    const state = userStates.get(chatId);

    if (!state) return false;

    if (msg.text?.toLowerCase() === '/cancel') {
        userStates.delete(chatId);
        await bot.sendMessage(chatId, '❌ Download cancelled.');
        return true;
    }

    if (state === 'waiting_for_url') {
        const url = msg.text;
        if (!url) {
            await bot.sendMessage(chatId, '⚠️ Please send a valid URL.');
            return true;
        }

        try {
            // Validate URL
            new URL(url);
            
            await bot.sendMessage(chatId, '🔍 Starting download...');
            userStates.delete(chatId);

            // Send the video using our existing sendVideo utility
            await sendVideo(bot, chatId, url, false);
        } catch (error) {
            if (error instanceof TypeError) {
                await bot.sendMessage(chatId, '❌ Invalid URL provided. Please provide a valid video URL.');
            } else {
                console.error('Error downloading video:', error);
                await bot.sendMessage(chatId, '❌ Failed to download and process the video. Please try again later.');
            }
            userStates.delete(chatId);
        }
        return true;
    }

    return false;
};

export const downloadCommand: Command = {
    name: 'download',
    description: 'Download and send a video from URL',
    execute: async (msg: TelegramBot.Message, bot: TelegramBot) => {
        const chatId = msg.chat.id;

        // Set user state to waiting for URL
        userStates.set(chatId, 'waiting_for_url');

        await bot.sendMessage(
            chatId,
            '📥 Please send me the video URL to download.\n\n' +
            'Examples:\n' +
            '• Direct video link (mp4, etc.)\n' +
            '• Streaming platform links\n\n' +
            'Type /cancel to cancel the download.',
            { parse_mode: 'Markdown' }
        );
    }
};