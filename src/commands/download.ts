import TelegramBot from 'node-telegram-bot-api';
import { Command } from '../types';
import { sendVideo } from '../utils/sendVideo';
import path from 'path';
import fs from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import Downloader from 'nodejs-file-downloader';
import ytdl from '@distube/ytdl-core';

// Rate limiting variables
const MIN_UPDATE_INTERVAL = 4000; // Minimum 4 seconds between updates as per Telegram's rate limit
const MAX_UPDATE_INTERVAL = 10000; // Maximum 10 seconds between updates
let lastUpdateTime = 0;
let currentUpdateInterval = MIN_UPDATE_INTERVAL;

// Add helper function for text comparison at the top
function normalizeProgressText(text: string): string {
    // Remove all whitespace and normalize numbers to handle floating point differences
    return text.replace(/\s+/g, '')
              .replace(/(\d+\.\d{2})\d*/g, '$1')
              .replace(/\d+%/g, match => Math.round(parseInt(match)) + '%');
}

// Add interface for context
interface UpdateContext {
    lastNormalizedText?: string;
}

// Update the updateProgressWithRetry function
async function updateProgressWithRetry(
    this: UpdateContext | void,
    bot: TelegramBot,
    chatId: number,
    messageId: number,
    text: string,
    retries = 3
): Promise<void> {
    try {
        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateTime;
        
        if (timeSinceLastUpdate < currentUpdateInterval) {
            return; // Skip this update if too soon
        }

        // Compare normalized text to avoid unnecessary updates
        const normalizedNewText = normalizeProgressText(text);
        if (this && normalizedNewText === this.lastNormalizedText) {
            return; // Skip if content is effectively the same
        }

        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML'
        });

        // Store normalized text for next comparison
        if (this) {
            this.lastNormalizedText = normalizedNewText;
        }

        // Success - decrease interval for next time (but not below minimum)
        currentUpdateInterval = Math.max(MIN_UPDATE_INTERVAL, currentUpdateInterval * 0.8);
        lastUpdateTime = now;
    } catch (error: any) {
        if (typeof error === 'object' && error !== null) {
            if (error.message?.includes('Too Many Requests') && retries > 0) {
                // Get retry delay from error response
                const retryAfter = error.response?.body?.parameters?.retry_after || 4;
                // Increase interval for next time
                currentUpdateInterval = Math.min(MAX_UPDATE_INTERVAL, currentUpdateInterval * 1.5);
                // Wait and retry
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                return updateProgressWithRetry.call(this, bot, chatId, messageId, text, retries - 1);
            } else if (!error.message?.includes('message is not modified') && retries > 0) {
                // Retry other errors (except "message not modified")
                await new Promise(resolve => setTimeout(resolve, 1000));
                return updateProgressWithRetry.call(this, bot, chatId, messageId, text, retries - 1);
            }
        }
        // Log error but don't throw to avoid crashing the download
        if (!error.message?.includes('message is not modified')) {
            console.error('Progress update error:', error);
        }
    }
}

// Store user states
const userStates = new Map<number, 'waiting_for_url'>();

// YouTube URL regex pattern
const YOUTUBE_URL_PATTERN = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;

// Add speed calculation helper
function calculateSpeed(bytesDownloaded: number, elapsedMs: number, totalSize: number): { speed: string; eta: string } {
    // Handle edge cases
    if (elapsedMs <= 0 || bytesDownloaded <= 0) {
        return {
            speed: '0 B/s',
            eta: 'calculating...'
        };
    }

    const bytesPerSecond = (bytesDownloaded / elapsedMs) * 1000;
    
    // Ensure we have valid numbers
    if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
        return {
            speed: '0 B/s',
            eta: 'calculating...'
        };
    }

    const speed = formatSize(bytesPerSecond) + '/s';
    
    // Calculate ETA
    const remainingBytes = Math.max(0, totalSize - bytesDownloaded);
    const etaSeconds = Math.round(remainingBytes / bytesPerSecond);
    
    // Handle invalid ETA
    if (!isFinite(etaSeconds) || etaSeconds < 0) {
        return {
            speed,
            eta: 'calculating...'
        };
    }

    const etaMinutes = Math.floor(etaSeconds / 60);
    const etaHours = Math.floor(etaMinutes / 60);
    
    let eta: string;
    if (etaHours > 24) {
        eta = '> 24h';
    } else if (etaHours > 0) {
        eta = `${etaHours}h ${etaMinutes % 60}m`;
    } else if (etaMinutes > 0) {
        eta = `${etaMinutes}m ${etaSeconds % 60}s`;
    } else if (etaSeconds > 0) {
        eta = `${etaSeconds}s`;
    } else {
        eta = 'almost done';
    }
    
    return { speed, eta };
}

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
                const lastBytes = (video as any).lastBytes || 0;
                const { speed, eta } = calculateSpeed(downloaded - lastBytes, now - lastUpdate, totalBytes);
                (video as any).lastBytes = downloaded;

                const progressText = 
                    `📥 Downloading YouTube video...\n` +
                    `${progressBar} ${progress}%\n` +
                    `💾 Size: ${formatSize(downloaded)}${total ? ` / ${formatSize(total)}` : ''}\n` +
                    `⚡ Speed: ${speed}\n` +
                    `⏱️ ETA: ${eta}\n` +
                    `📝 Title: ${info.videoDetails.title}`;

                updateProgressWithRetry(bot, chatId, progressMsg.message_id, progressText)
                    .catch(console.error);
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
                        onProgress: function(percentage: string | number, chunk: { downloadedBytes?: number }, remainingSize: number) {
                            const now = Date.now();
                            const lastUpdate = (this as any).lastUpdate || 0;
                            const currentProgress = Math.round(Number(percentage));
                            
                            // Only update if progress changed by at least 1% and 3 seconds passed
                            if ((now - lastUpdate >= 3000 && currentProgress !== (this as any).lastProgress) || 
                                currentProgress % 10 === 0) {
                                const progressBar = '█'.repeat(Math.floor(currentProgress / 5)) + '░'.repeat(20 - Math.floor(currentProgress / 5));
                                
                                // Calculate speed and ETA
                                const downloadedBytes = chunk.downloadedBytes || 0;
                                const totalSize = downloadedBytes + remainingSize;
                                const lastBytes = (this as any).lastBytes || 0;
                                const { speed, eta } = calculateSpeed(downloadedBytes - lastBytes, now - lastUpdate, totalSize);
                                (this as any).lastBytes = downloadedBytes;

                                const progressText = `📥 Downloading...\n` +
                                    `${progressBar} ${currentProgress}%\n` +
                                    `💾 Size: ${formatSize(downloadedBytes)} / ${formatSize(totalSize)}\n` +
                                    `⚡ Speed: ${speed}\n` +
                                    `⏱️ ETA: ${eta}`;
                                
                                // Use the new update function
                                updateProgressWithRetry(bot, chatId, progressMsg.message_id, progressText)
                                    .catch(error => {
                                        if (!error?.message?.includes('message is not modified')) {
                                            console.error('Progress update error:', error);
                                        }
                                    });
                                
                                (this as any).lastUpdate = now;
                                (this as any).lastProgress = currentProgress;
                            }
                        },
                        maxAttempts: 3,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            // Add common headers for direct downloads
                            'Accept': '*/*',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Connection': 'keep-alive',
                            'Referer': url
                        },
                        // Add timeout and retry options
                        timeout: 30000,
                        skipExistingFileName: true,
                        shouldStop: (error: Error) => {
                            // Stop if we get a fatal error
                            return error.message?.includes('ECONNRESET') || 
                                   error.message?.includes('ETIMEDOUT');
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