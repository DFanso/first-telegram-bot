import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import { getVideosFromDirectory } from '../utils/getVideos';
import { sendVideo } from '../utils/sendVideo';
import { getVideoMetadata } from '../commands/info';

const VIDEOS_DIR = path.join(__dirname, '../../assets/videos');

export async function handleCallback(callbackQuery: TelegramBot.CallbackQuery, bot: TelegramBot) {
    const chatId = callbackQuery.message?.chat.id;
    if (!chatId || !callbackQuery.data) return;

    if (callbackQuery.data.startsWith('select_video:')) {
        const index = parseInt(callbackQuery.data.split(':')[1]);
        const videos = getVideosFromDirectory(VIDEOS_DIR);

        if (index >= 0 && index < videos.length) {
            const selectedVideo = videos[index];
            
            // Remove the inline keyboard
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: chatId,
                message_id: callbackQuery.message?.message_id
            });

            // Send a message indicating which video was selected
            await bot.sendMessage(chatId, `Sending video: ${selectedVideo.name}`);

            // Send the selected video
            await sendVideo(bot, chatId, selectedVideo.path, true);
        }
    } else if (callbackQuery.data.startsWith('video_info:')) {
        const index = parseInt(callbackQuery.data.split(':')[1]);
        const videos = getVideosFromDirectory(VIDEOS_DIR);

        if (index >= 0 && index < videos.length) {
            const selectedVideo = videos[index];
            const metadata = await getVideoMetadata(selectedVideo.path);

            // Remove the inline keyboard
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: chatId,
                message_id: callbackQuery.message?.message_id
            });

            // Send detailed video information
            const infoMessage = `📽 *Video Information*\n\n` +
                `📁 *Name:* ${selectedVideo.name}\n` +
                `⏱ *Duration:* ${metadata.duration}\n` +
                `📐 *Resolution:* ${metadata.resolution}\n` +
                `📼 *Format:* ${metadata.format}\n` +
                `📊 *Bitrate:* ${metadata.bitrate}\n` +
                `💾 *Size:* ${metadata.size}`;

            await bot.sendMessage(chatId, infoMessage, {
                parse_mode: 'Markdown'
            });
        }
    }
} 