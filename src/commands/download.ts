import TelegramBot from 'node-telegram-bot-api';
import { Command } from '../types';
import { sendVideo } from '../utils/sendVideo';
import path from 'path';
import fs from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import Downloader from 'nodejs-file-downloader';
import ytdl from '@distube/ytdl-core';

// Store user states
const userStates = new Map<number, 'waiting_for_url'>();

// YouTube URL regex pattern
const YOUTUBE_URL_PATTERN = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;

async function downloadYouTubeVideo(url: string, tempDir: string, bot: TelegramBot, chatId: number, progressMsg: TelegramBot.Message): Promise<{ filePath: string; fileName: string }> {
    try {
        // Get video info
        const info = await ytdl.getInfo(url);
        const videoFormat = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'videoandaudio' });
        
        if (!videoFormat) {
            throw new Error('No suitable video format found');
        }

        // Create sanitized filename
        const sanitizedTitle = info.videoDetails.title.replace(/[<>:"/\\|?*]/g, '_').replace(/[\u{1F300}-\u{1F9FF}]/gu, '').trim();
        const fileName = `${sanitizedTitle}.${videoFormat.container || 'mp4'}`;
        const filePath = path.join(tempDir, fileName);

        // Download with progress tracking
        const video = ytdl(url, {
            format: videoFormat
        });

        let lastUpdate = Date.now();
        let downloadedBytes = 0;
        const totalBytes = parseInt(videoFormat.contentLength) || 0;

        video.on('progress', (_, downloaded, total) => {
            downloadedBytes = downloaded;
            const now = Date.now();
            if (now - lastUpdate >= 3000) {
                const progress = total ? Math.round((downloaded / total) * 100) : 0;
                const progressBar = '█'.repeat(Math.floor(progress / 5)) + '░'.repeat(20 - Math.floor(progress / 5));
                bot.editMessageText(
                    `📥 Downloading YouTube video...\n` +
                    `${progressBar} ${progress}%\n` +
                    `💾 Size: ${formatSize(downloaded)}${total ? ` / ${formatSize(total)}` : ''}\n` +
                    `📝 Title: ${info.videoDetails.title}`,
                    {
                        chat_id: chatId,
                        message_id: progressMsg.message_id,
                        parse_mode: 'HTML'
                    }
                ).catch(console.error);
                lastUpdate = now;
            }
        });

        // Create write stream
        const writer = createWriteStream(filePath);
        await new Promise<void>((resolve, reject) => {
            video.pipe(writer);
            writer.on('finish', () => resolve());
            writer.on('error', reject);
            video.on('error', reject);
        });

        return {
            filePath,
            fileName
        };
    } catch (error) {
        console.error('YouTube download error:', error);
        throw new Error(error instanceof Error ? error.message : 'Failed to download YouTube video');
    }
}

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
            // Check if it's a magnet link
            if (url.startsWith('magnet:')) {
                await bot.sendMessage(chatId, '⚠️ Please use /torrent command for magnet links instead.');
                userStates.delete(chatId);
                return true;
            }
            
            // Validate URL
            new URL(url);

            // Create temp directory
            const tempDir = path.join(process.env.TEMP || process.env.TMP || path.join(process.cwd(), 'temp'), 'telegram-bot', Date.now().toString());
            await fs.promises.mkdir(tempDir, { recursive: true });

            // Send initial message
            const progressMsg = await bot.sendMessage(chatId, '📥 Starting download...');

            try {
                let filePath: string;
                let fileName: string;

                // Check if it's a YouTube URL
                if (YOUTUBE_URL_PATTERN.test(url)) {
                    // Download using ytdl-core
                    const result = await downloadYouTubeVideo(url, tempDir, bot, chatId, progressMsg);
                    filePath = result.filePath;
                    fileName = result.fileName;
                } else {
                    // Use regular downloader for other URLs
                    const downloader = new Downloader({
                        url,
                        directory: tempDir,
                        onProgress: function(percentage, chunk, remainingSize) {
                            const now = Date.now();
                            const lastUpdate = (this as any).lastUpdate || 0;
                            
                            if (now - lastUpdate >= 3000 || Number(percentage) % 10 === 0) {
                                const progressBar = '█'.repeat(Math.floor(Number(percentage) / 5)) + '░'.repeat(20 - Math.floor(Number(percentage) / 5));
                                bot.editMessageText(
                                    `📥 Downloading...\n${progressBar} ${Math.round(Number(percentage))}%\n` +
                                    `💾 Remaining: ${formatSize(remainingSize)}`,
                                    {
                                        chat_id: chatId,
                                        message_id: progressMsg.message_id,
                                        parse_mode: 'HTML'
                                    }
                                ).catch(console.error);
                                (this as any).lastUpdate = now;
                            }
                        },
                        maxAttempts: 3,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                        }
                    });

                    const { filePath: downloadedPath } = await downloader.download();
                    
                    if (!downloadedPath) {
                        throw new Error('Download failed: No file path returned');
                    }

                    filePath = downloadedPath;
                    fileName = path.basename(downloadedPath);
                }

                // Get file info
                const stats = await fs.promises.stat(filePath);

                // Update message to show completion
                await bot.editMessageText(
                    `✅ Download complete!\n📦 Size: ${formatSize(stats.size)}\n📤 Sending file...`,
                    {
                        chat_id: chatId,
                        message_id: progressMsg.message_id
                    }
                );

                // Check if it's a video
                const isVideo = fileName.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|flv)$/);
                if (isVideo) {
                    await sendVideo(bot, chatId, url, false);
                } else {
                    // Send as document
                    const fileStream = createReadStream(filePath);
                    await bot.sendDocument(chatId, fileStream, {
                        caption: fileName
                    });
                }

                // Clean up
                try {
                    await fs.promises.unlink(filePath);
                    await fs.promises.rmdir(path.dirname(filePath));
                } catch (cleanupError) {
                    console.error('Error cleaning up temp files:', cleanupError);
                }

                // Delete progress message and show completion
                await bot.deleteMessage(chatId, progressMsg.message_id);
                await bot.sendMessage(chatId, '✅ File sent successfully!');
            } catch (downloadError) {
                console.error('Download error:', downloadError);
                await bot.editMessageText(
                    `❌ Download failed: ${downloadError instanceof Error ? downloadError.message : 'Unknown error occurred'}`,
                    {
                        chat_id: chatId,
                        message_id: progressMsg.message_id
                    }
                );
            }

            userStates.delete(chatId);
        } catch (error) {
            console.error('Error:', error);
            await bot.sendMessage(
                chatId,
                `❌ ${error instanceof TypeError ? 'Invalid URL provided.' : 'Failed to process the file. Please try again later.'}`
            );
            userStates.delete(chatId);
        }
        return true;
    }

    return false;
};

// Utility function to format file size
function formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

export const downloadCommand: Command = {
    name: 'download',
    description: 'Download and send any file from URL (including YouTube videos)',
    execute: async (msg: TelegramBot.Message, bot: TelegramBot) => {
        const chatId = msg.chat.id;

        // Set user state to waiting for URL
        userStates.set(chatId, 'waiting_for_url');

        await bot.sendMessage(
            chatId,
            '📥 Please send me the URL to download.\n\n' +
            'Supported content types:\n' +
            '• YouTube Videos\n' +
            '• Videos (MP4, WebM, etc.)\n' +
            '• Documents (PDF, DOC, etc.)\n' +
            '• Images (JPG, PNG, etc.)\n' +
            '• Archives (ZIP, RAR, etc.)\n' +
            '• And many more!\n\n' +
            'Type /cancel to cancel the download.',
            { parse_mode: 'Markdown' }
        );
    }
};