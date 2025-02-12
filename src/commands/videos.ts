import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import { Command } from '../types';
import { getVideosFromDirectory } from '../utils/getVideos';
import { sendVideo } from '../utils/sendVideo';

const VIDEOS_DIR = path.join(__dirname, '../../assets/videos');

export const videosCommand: Command = {
    name: 'videos',
    description: 'List and select available videos to send',
    execute: async (msg: TelegramBot.Message, bot: TelegramBot) => {
        const chatId = msg.chat.id;
        const videos = getVideosFromDirectory(VIDEOS_DIR);

        if (videos.length === 0) {
            await bot.sendMessage(chatId, 'No videos found in the directory.');
            return;
        }

        // Create inline keyboard with video options
        const keyboard = videos.map((video, index) => [{
            text: `${video.name} (${video.size})`,
            callback_data: `select_video:${index}`
        }]);

        await bot.sendMessage(chatId, 'Select a video to send:', {
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    }
}; 