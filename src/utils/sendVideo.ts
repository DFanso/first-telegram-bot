import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

export async function sendVideo(bot: TelegramBot, chatId: number, videoPath: string, local: boolean = true) {



    try {
        if (!local) {
            if (!videoPath) {
                throw new Error('Video path is required for remote videos');
            }
            // Download remote video first with progress
            const tempPath = path.join(tmpdir(), `${uuidv4()}.mp4`);
            let downloadedBytes = 0;
            let totalBytes = 0;
            await new Promise<void>((resolve, reject) => {
                https.get(videoPath!, res => {
                    if (res.headers['content-length']) {
                        totalBytes = parseInt(res.headers['content-length'], 10);
                    }
                    const fileStream = fs.createWriteStream(tempPath);
                    res.pipe(fileStream);
                    res.on('data', chunk => {
                        downloadedBytes += chunk.length;
                        const progress = Math.round((downloadedBytes / totalBytes) * 100);
                        console.log(`Download progress: ${progress}%`);
                    });
                    fileStream.on('finish', () => resolve());
                    fileStream.on('error', reject);
                }).on('error', reject);
            });
            videoPath = tempPath;
            local = true;
        }

        const videoSize = await getVideoSize(videoPath);
        let finalPath ;
        if (parseFloat(videoSize) > 50) {
            finalPath = await splitVideo(videoPath);

        }

        finalPath = videoPath;
        

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



async function getVideoSize(videoPath: string) {
    const stats = fs.statSync(videoPath);
    const fileSizeInBytes = stats.size;
    console.log(`Video size: ${(fileSizeInBytes / 1024 / 1024).toFixed(2)}Mb`);
    
    return (fileSizeInBytes / 1024 / 1024).toFixed(2);
}


// if video size is too large, make it to 50Mb separate file
async function splitVideo(videoPath: string) {
    const stats = fs.statSync(videoPath);
    const fileSizeInBytes = stats.size;
    const videoSize = await getVideoSize(videoPath);
    if (parseFloat(videoSize) > 50) {
        const tempPath = path.join(tmpdir(), `${uuidv4()}.mp4`);
        const videoStream = fs.createReadStream(videoPath);
        const fileStream = fs.createWriteStream(tempPath);
        videoStream.pipe(fileStream);
        return tempPath;
    }
    return videoPath;
}