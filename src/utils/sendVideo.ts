import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
        
        if (parseFloat(videoSize) > 50) {
            const parts = await splitVideo(videoPath);
            console.log(`Splitting video into ${parts.length} parts`);
            
            // Send each part
            for (let i = 0; i < parts.length; i++) {
                const caption = `Part ${i + 1}/${parts.length}`;
                await sendVideoPart(bot, chatId, parts[i], caption);
                // Cleanup part file
                fs.unlinkSync(parts[i]);
            }
        } else {
            await sendVideoPart(bot, chatId, videoPath);
        }

        // Cleanup temp file if it was a remote video
        if (videoPath.includes(tmpdir())) {
            fs.unlinkSync(videoPath);
        }
    } catch (error) {
        console.error('Error sending video:', error);
        await bot.sendMessage(chatId, 'Sorry, there was an error sending the video.');
    }
}

async function sendVideoPart(bot: TelegramBot, chatId: number, videoPath: string, caption = 'Here is your video!') {
    const videoStream = fs.createReadStream(videoPath);
    const stats = fs.statSync(videoPath);
    const fileSizeInBytes = stats.size;
    let uploadedBytes = 0;

    videoStream.on('data', (chunk: string | Buffer) => {
        uploadedBytes += Buffer.from(chunk).length;
        const progress = Math.round((uploadedBytes / fileSizeInBytes) * 100);
        console.log(`Upload progress: ${progress}%`);
    });

    await bot.sendVideo(chatId, videoStream, { caption });
}

async function getVideoSize(videoPath: string) {
    const stats = fs.statSync(videoPath);
    const fileSizeInBytes = stats.size;
    console.log(`Video size: ${(fileSizeInBytes / 1024 / 1024).toFixed(2)}Mb`);
    
    return (fileSizeInBytes / 1024 / 1024).toFixed(2);
}

async function splitVideo(videoPath: string): Promise<string[]> {
    const outputDir = tmpdir();
    const baseName = path.join(outputDir, uuidv4());
    const duration = await getVideoDuration(videoPath);
    const parts: string[] = [];
    const partDuration = Math.ceil(duration / Math.ceil(duration / 45)); // Split into ~45s segments

    for (let start = 0; start < duration; start += partDuration) {
        const outputPath = `${baseName}-part${parts.length + 1}.mp4`;
        await execAsync(
            `ffmpeg -i "${videoPath}" -ss ${start} -t ${partDuration} -c copy "${outputPath}"`
        );
        parts.push(outputPath);
    }

    return parts;
}

async function getVideoDuration(videoPath: string): Promise<number> {
    const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    );
    return Math.ceil(parseFloat(stdout));
}