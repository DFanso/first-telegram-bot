import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { tmpdir } from 'os';

export async function sendVideo(bot: TelegramBot, chatId: number, videoPath: string, local: boolean = true) {
    try {
        if (!local) {
            if (!videoPath) {
                throw new Error('Video path is required for remote videos');
            }
            // Download remote video first
            const tempPath = path.join(tmpdir(), 'temp-video.mp4');
            await new Promise<void>((resolve, reject) => {
                https.get(videoPath!, res => {
                    const fileStream = fs.createWriteStream(tempPath);
                    res.pipe(fileStream);
                    fileStream.on('finish', () => resolve());
                    fileStream.on('error', reject);
                }).on('error', reject);
            });
            videoPath = tempPath;
            local = true;
        }

        const finalPath = videoPath || path.join(__dirname, '../../assets/video.mp4');

        if (!fs.existsSync(finalPath)) {
            throw new Error('Video file not found: ' + finalPath);
        }

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

        // Cleanup temp file if it was a remote video
        if (videoPath.includes(tmpdir())) {
            fs.unlinkSync(videoPath);
        }
    } catch (error) {
        console.error('Error sending video:', error);
        await bot.sendMessage(chatId, 'Sorry, there was an error sending the video.');
    }
}
