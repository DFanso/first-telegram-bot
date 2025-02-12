import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';

export async function sendVideo(bot: TelegramBot, chatId: number, videoPath?: string, local: boolean = true) {
    try {
        const finalPath = local 
            ? (videoPath || path.join(__dirname, '../../assets/video.mp4'))
            : videoPath;

        if (!finalPath) {
            throw new Error('Video path is required for remote videos');
        }

        if (local && !fs.existsSync(finalPath)) {
            throw new Error('Video file not found: ' + finalPath);
        }

        if (local) {
            const videoStream = fs.createReadStream(finalPath);
            const stats = fs.statSync(finalPath);
            const fileSizeInBytes = stats.size;
            let uploadedBytes = 0;

            videoStream.on('data', (chunk: string | Buffer) => {
                uploadedBytes += Buffer.from(chunk).length;
                const progress = Math.round((uploadedBytes / fileSizeInBytes) * 100);
                console.log(`Upload progress: ${progress}%`);
            });

            await bot.sendVideo(chatId, videoStream, {
                caption: 'Here is your video!'
            });
        } else {
            await bot.sendVideo(chatId, finalPath, {
                caption: 'Here is your video!'
            });
        }
    } catch (error) {
        console.error('Error sending video:', error);
        await bot.sendMessage(chatId, 'Sorry, there was an error sending the video.');
    }
}
