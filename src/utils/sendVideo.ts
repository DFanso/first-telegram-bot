import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Constants
const MAX_VIDEO_SIZE_MB = 2000; // 2000MB (2GB) limit for local API
const MAX_SEGMENT_DURATION = 10000; 

async function formatFileSize(bytes: number): Promise<string> {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function updateProgressMessage(bot: TelegramBot, chatId: number, messageId: number, progress: number, stage: 'download' | 'upload', details: { 
    fileName?: string;
    totalSize?: number;
    currentSize?: number;
    speed?: number;
} = {}) {
    const status = stage === 'download' ? '⬇️ Downloading' : '⬆️ Uploading';
    const progressBar = '█'.repeat(Math.floor(progress / 5)) + '░'.repeat(20 - Math.floor(progress / 5));
    
    let text = `${status}`;
    if (details.fileName) {
        text += `\n📁 File: ${details.fileName}`;
    }
    if (details.totalSize) {
        text += `\n💾 Size: ${await formatFileSize(details.totalSize)}`;
    }
    if (details.currentSize && details.totalSize) {
        text += `\n📊 Progress: ${await formatFileSize(details.currentSize)} of ${await formatFileSize(details.totalSize)}`;
    }
    if (details.speed) {
        text += `\n⚡ Speed: ${await formatFileSize(details.speed)}/s`;
    }
    text += `\n\n${progressBar} ${progress}%`;
    
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML'
        });
    } catch (error: any) {
        if (!error.message?.includes('message is not modified')) {
            console.error('Error updating progress:', error);
        }
    }
}

export async function sendVideo(bot: TelegramBot, chatId: number, videoPath: string, local: boolean = true) {
    try {
        let progressMessageId: number | undefined;
        let lastProgress = -1;
        let lastUpdateTime = Date.now();
        let lastBytes = 0;

        // Initialize progress message for both local and remote videos
        const fileName = local ? path.basename(videoPath) : (videoPath.split('/').pop() || 'video.mp4');
        const msg = await bot.sendMessage(chatId, '⬇️ Preparing...\n░░░░░░░░░░░░░░░░░░░░ 0%');
        progressMessageId = msg.message_id;
        
        if (!local) {
            if (!videoPath) {
                throw new Error('Video path is required for remote videos');
            }
            
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
                    res.on('data', async chunk => {
                        downloadedBytes += chunk.length;
                        const progress = Math.round((downloadedBytes / totalBytes) * 100);
                        const now = Date.now();
                        const timeDiff = now - lastUpdateTime;
                        
                        if (progressMessageId && progress % 5 === 0 && progress !== lastProgress) {
                            const byteDiff = downloadedBytes - lastBytes;
                            const speed = byteDiff / (timeDiff / 1000);
                            
                            lastProgress = progress;
                            lastUpdateTime = now;
                            lastBytes = downloadedBytes;
                            
                            await updateProgressMessage(bot, chatId, progressMessageId, progress, 'download', {
                                fileName,
                                totalSize: totalBytes,
                                currentSize: downloadedBytes,
                                speed
                            });
                        }
                    });
                    fileStream.on('finish', () => resolve());
                    fileStream.on('error', reject);
                }).on('error', reject);
            });
            videoPath = tempPath;
            local = true;
            lastProgress = -1;
            lastUpdateTime = Date.now();
            lastBytes = 0;
        }

        const videoSize = await getVideoSize(videoPath);
        
        if (parseFloat(videoSize) > MAX_VIDEO_SIZE_MB) {
            const parts = await splitVideo(videoPath);
            console.log(`Splitting video into ${parts.length} parts (size: ${videoSize}MB, limit: ${MAX_VIDEO_SIZE_MB}MB)`);
            
            for (let i = 0; i < parts.length; i++) {
                const caption = `Part ${i + 1}/${parts.length}`;
                const partFileName = `${fileName} (Part ${i + 1}/${parts.length})`;
                if (progressMessageId) {
                    await updateProgressMessage(bot, chatId, progressMessageId, 0, 'upload', {
                        fileName: partFileName
                    });
                }
                await sendVideoPart(bot, chatId, parts[i], caption, progressMessageId, partFileName);
                fs.unlinkSync(parts[i]);
            }
        } else {
            await sendVideoPart(bot, chatId, videoPath, 'Here is your video!', progressMessageId, fileName);
        }

        // Clean up progress message
        if (progressMessageId) {
            try {
                await bot.deleteMessage(chatId, progressMessageId);
            } catch (error) {
                console.error('Error deleting progress message:', error);
            }
        }

        if (videoPath.includes(tmpdir())) {
            fs.unlinkSync(videoPath);
        }
    } catch (error) {
        console.error('Error sending video:', error);
        await bot.sendMessage(chatId, 'Sorry, there was an error sending the video.');
    }
}

async function sendVideoPart(
    bot: TelegramBot, 
    chatId: number, 
    videoPath: string, 
    caption = 'Here is your video!', 
    progressMessageId?: number,
    fileName?: string
) {
    const videoStream = fs.createReadStream(videoPath);
    const stats = fs.statSync(videoPath);
    const fileSizeInBytes = stats.size;
    let uploadedBytes = 0;
    let lastProgress = -1;
    let lastUpdateTime = Date.now();
    let lastBytes = 0;

    if (progressMessageId) {
        await updateProgressMessage(bot, chatId, progressMessageId, 0, 'upload', {
            fileName: fileName || path.basename(videoPath),
            totalSize: fileSizeInBytes,
            currentSize: 0
        });
    }

    videoStream.on('data', async (chunk: string | Buffer) => {
        uploadedBytes += Buffer.from(chunk).length;
        const progress = Math.round((uploadedBytes / fileSizeInBytes) * 100);
        const now = Date.now();
        const timeDiff = now - lastUpdateTime;

        if (progressMessageId && progress % 5 === 0 && progress !== lastProgress) {
            const byteDiff = uploadedBytes - lastBytes;
            const speed = byteDiff / (timeDiff / 1000);
            
            lastProgress = progress;
            lastUpdateTime = now;
            lastBytes = uploadedBytes;

            await updateProgressMessage(bot, chatId, progressMessageId, progress, 'upload', {
                fileName: fileName || path.basename(videoPath),
                totalSize: fileSizeInBytes,
                currentSize: uploadedBytes,
                speed
            });
        }
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
    const partDuration = Math.ceil(duration / Math.ceil(duration / MAX_SEGMENT_DURATION)); // Split into segments

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