import TelegramBot from 'node-telegram-bot-api';
import { Command } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { getVideosFromDirectory } from '../utils/getVideos';

const execAsync = promisify(exec);
const VIDEOS_DIR = path.join(__dirname, '../../assets/videos');

interface VideoMetadata {
    duration: string;
    resolution: string;
    format: string;
    bitrate: string;
    size: string;
}

export async function getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
    const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}"`;
    const { stdout } = await execAsync(cmd);
    const data = JSON.parse(stdout);
    
    const videoStream = data.streams.find((s: any) => s.codec_type === 'video');
    const format = data.format;
    
    return {
        duration: format.duration ? `${Math.floor(parseFloat(format.duration) / 60)}:${Math.floor(parseFloat(format.duration) % 60)}` : 'Unknown',
        resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : 'Unknown',
        format: videoStream?.codec_name?.toUpperCase() || 'Unknown',
        bitrate: format.bit_rate ? `${Math.floor(parseInt(format.bit_rate) / 1024)} Kbps` : 'Unknown',
        size: format.size ? `${(parseInt(format.size) / (1024 * 1024)).toFixed(2)} MB` : 'Unknown'
    };
}

export const infoCommand: Command = {
    name: 'info',
    description: 'Show detailed information about available videos',
    execute: async (msg: TelegramBot.Message, bot: TelegramBot) => {
        const chatId = msg.chat.id;
        const videos = getVideosFromDirectory(VIDEOS_DIR);

        if (videos.length === 0) {
            await bot.sendMessage(chatId, 'No videos found in the directory.');
            return;
        }

        // Create inline keyboard with video options
        const keyboard = videos.map((video, index) => [{
            text: video.name,
            callback_data: `video_info:${index}`
        }]);

        await bot.sendMessage(chatId, 'Select a video to see detailed information:', {
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    }
}; 