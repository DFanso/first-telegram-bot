import TelegramBot from 'node-telegram-bot-api';
import { Command } from '../types';
import { config } from '../config';
import path from 'path';
import { sendVideo } from '../utils/sendVideo';
import { qbittorrent } from '../services/qbittorrent';
import fs from 'fs';
import { promisify } from 'util';
import archiver from 'archiver';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

// Store user states and torrent info
const userStates = new Map<number, 'waiting_for_magnet'>();
const torrentProgress = new Map<string, { chatId: number, messageId: number }>();

// Handler for magnet URL input
export const handleTorrentInput = async (msg: TelegramBot.Message, bot: TelegramBot): Promise<boolean> => {
    const chatId = msg.chat.id;
    const state = userStates.get(chatId);

    if (!state) return false;

    if (msg.text?.toLowerCase() === '/cancel') {
        userStates.delete(chatId);
        await bot.sendMessage(chatId, '❌ Torrent download cancelled.');
        return true;
    }

    if (state === 'waiting_for_magnet') {
        const magnetUrl = msg.text;
        if (!magnetUrl?.startsWith('magnet:')) {
            await bot.sendMessage(chatId, '⚠️ Please send a valid magnet URL.');
            return true;
        }

        try {
            // Send initial status message
            const statusMsg = await bot.sendMessage(chatId, '🔍 Adding torrent to qBittorrent...');

            // Extract hash from magnet URL
            const hashMatch = magnetUrl.match(/xt=urn:btih:([^&]+)/i);
            if (!hashMatch) {
                throw new Error('Invalid magnet URL: Could not find hash');
            }
            const hash = hashMatch[1].toLowerCase();

            // Add torrent to qBittorrent
            await qbittorrent.addMagnet(magnetUrl);
            
            // Get torrent info with retries
            let torrent = null;
            let retries = 3;
            
            while (retries > 0 && !torrent) {
                const torrents = await qbittorrent.getTorrents();
                torrent = torrents.find(t => t.hash.toLowerCase() === hash);
                if (!torrent) {
                    retries--;
                    if (retries > 0) {
                        await new Promise(resolve => setTimeout(resolve, 2000)); // Increased wait time
                    }
                }
            }

            if (!torrent) {
                throw new Error('Torrent was added but could not be found in the list. It might still be processing.');
            }

            // Update status message with initial info
            await bot.editMessageText(
                `✅ Torrent added successfully!\n` +
                `📥 Name: ${torrent.name}\n` +
                `💾 Size: ${formatSize(torrent.size)}\n` +
                `⏳ Starting download...`,
                {
                    chat_id: chatId,
                    message_id: statusMsg.message_id
                }
            );

            // Store torrent info for progress tracking
            torrentProgress.set(torrent.hash, {
                chatId,
                messageId: statusMsg.message_id
            });

            // Start progress monitoring
            monitorTorrentProgress(torrent.hash, bot);

            userStates.delete(chatId);
        } catch (error) {
            console.error('Error adding torrent:', error);
            await bot.sendMessage(
                chatId, 
                `❌ ${error instanceof Error ? error.message : 'Failed to add torrent. Please try again later.'}`
            );
            userStates.delete(chatId);
        }
        return true;
    }

    return false;
};

// Monitor torrent download progress
async function monitorTorrentProgress(hash: string, bot: TelegramBot) {
    const progress = torrentProgress.get(hash);
    if (!progress) return;

    try {
        const torrents = await qbittorrent.getTorrents();
        const torrent = torrents.find(t => t.hash === hash);
        if (!torrent) return;

        const progressPercent = Math.round(torrent.progress * 100);
        const progressBar = '█'.repeat(Math.floor(progressPercent / 5)) + '░'.repeat(20 - Math.floor(progressPercent / 5));

        // Update progress message
        const progressText = `📥 Downloading: ${torrent.name}\n\n` +
            `${progressBar} ${progressPercent}%\n\n` +
            `⚡ Speed: ${formatSpeed(torrent.dlspeed)}\n` +
            `💾 Size: ${formatSize(torrent.size)}\n` +
            `🌱 Seeds: ${torrent.num_seeds}\n` +
            `👥 Peers: ${torrent.num_leechs}\n` +
            `📊 Status: ${torrent.state}`;

        await bot.editMessageText(progressText, {
            chat_id: progress.chatId,
            message_id: progress.messageId,
            parse_mode: 'HTML'
        });

        // If download is complete
        if (torrent.progress === 1) {
            await handleCompletedTorrent(torrent, bot, progress.chatId);
            torrentProgress.delete(hash);
            return;
        }

        // Continue monitoring
        setTimeout(() => monitorTorrentProgress(hash, bot), 5000);
    } catch (error) {
        console.error('Error monitoring torrent:', error);
    }
}

// Handle completed torrent
async function handleCompletedTorrent(torrent: any, bot: TelegramBot, chatId: number) {
    try {
        await bot.sendMessage(chatId, '✅ Download complete! Processing file...');
        
        // Get the file from qBittorrent
        const fileInfo = await qbittorrent.downloadFile(torrent.hash);
        
        // Convert network path to local path if needed
        let sourceFilePath = fileInfo.path;
        if (config.QBITTORRENT_NETWORK_PATH && config.QBITTORRENT_DOWNLOAD_PATH) {
            sourceFilePath = sourceFilePath.replace(
                config.QBITTORRENT_NETWORK_PATH,
                path.resolve(config.QBITTORRENT_DOWNLOAD_PATH)
            );
        }

        // Sanitize file paths
        const sanitizedSourcePath = decodeURIComponent(sourceFilePath).replace(/[\u{1F300}-\u{1F9FF}]/gu, '').trim();
        
        // Verify file exists
        if (!fs.existsSync(sanitizedSourcePath)) {
            throw new Error(`File not found at local path: ${sanitizedSourcePath}`);
        }

        const fileName = path.basename(sanitizedSourcePath)
            .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Remove emojis
            .replace(/[^\w\s\-\.]/g, '_') // Replace special chars with underscore
            .trim();
        
        // Create temp directory with elevated permissions
        const tempDir = path.join(process.cwd(), 'temp', Date.now().toString());
        try {
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true, mode: 0o777 });
            }
        } catch (mkdirError) {
            console.error('Failed to create temp directory:', mkdirError);
            throw new Error('Failed to create temporary directory. Please check folder permissions.');
        }

        // Get file size
        const stats = await fs.promises.stat(sanitizedSourcePath);
        const fileSize = stats.size;
        const PART_SIZE = 2 * 1024 * 1024 * 1024; // 2GB in bytes

        // If file is larger than 2GB, split into parts
        if (fileSize > PART_SIZE) {
            await bot.sendMessage(chatId, '📦 File is larger than 2GB. Splitting and compressing into parts...');
            
            // Create a worker for compression and splitting
            const worker = new Worker(`
                const { parentPort, workerData } = require('worker_threads');
                const fs = require('fs');
                const archiver = require('archiver');
                const path = require('path');

                async function compressAndSplit() {
                    const { sourceFilePath, tempDir, PART_SIZE, fileName } = workerData;
                    const parts = [];
                    let partNum = 1;
                    let processedBytes = 0;

                    try {
                        while (processedBytes < fs.statSync(sourceFilePath).size) {
                            const archive = archiver('zip', { zlib: { level: 9 } });
                            const partPath = path.join(tempDir, \`\${fileName}.part\${partNum}.zip\`);
                            const output = fs.createWriteStream(partPath, { mode: 0o666 });

                            archive.on('error', (err) => {
                                throw err;
                            });

                            archive.pipe(output);

                            const currentPartSize = Math.min(PART_SIZE, fs.statSync(sourceFilePath).size - processedBytes);
                            archive.append(fs.createReadStream(sourceFilePath, {
                                start: processedBytes,
                                end: processedBytes + currentPartSize - 1,
                                mode: 0o666
                            }), { name: fileName });

                            await archive.finalize();
                            parts.push(partPath);
                            processedBytes += currentPartSize;
                            partNum++;
                            
                            parentPort.postMessage({ 
                                type: 'progress', 
                                progress: (processedBytes / fs.statSync(sourceFilePath).size) * 100 
                            });
                        }

                        parentPort.postMessage({ type: 'complete', parts });
                    } catch (error) {
                        parentPort.postMessage({ 
                            type: 'error', 
                            error: \`Compression error: \${error.message}\` 
                        });
                    }
                }

                compressAndSplit().catch(error => {
                    parentPort.postMessage({ 
                        type: 'error', 
                        error: \`Worker error: \${error.message}\` 
                    });
                });
            `, { eval: true, workerData: { 
                sourceFilePath: sanitizedSourcePath, 
                tempDir, 
                PART_SIZE, 
                fileName 
            }});

            // Handle worker messages
            worker.on('message', async (message) => {
                if (message.type === 'progress') {
                    await bot.sendMessage(chatId, `📦 Compression progress: ${Math.round(message.progress)}%`);
                } else if (message.type === 'complete') {
                    const parts = message.parts;
                    await bot.sendMessage(chatId, `✅ File split and compressed into ${parts.length} parts. Sending files...`);
                    
                    // Send each part
                    for (let i = 0; i < parts.length; i++) {
                        try {
                            const partPath = parts[i];
                            await bot.sendDocument(chatId, partPath, {
                                caption: `Part ${i + 1} of ${parts.length}: ${path.basename(partPath)}`
                            });
                            // Clean up part file after sending
                            try {
                                fs.unlinkSync(partPath);
                            } catch (unlinkError) {
                                console.error(`Failed to delete part file ${partPath}:`, unlinkError);
                            }
                        } catch (sendError: any) {
                            console.error(`Failed to send part ${i + 1}:`, sendError);
                            throw new Error(`Failed to send part ${i + 1}: ${sendError?.message || 'Unknown error'}`);
                        }
                    }
                    
                    await bot.sendMessage(chatId, '✅ All parts sent successfully!');
                } else if (message.type === 'error') {
                    throw new Error(message.error);
                }
            });

            // Handle worker errors
            worker.on('error', (error) => {
                throw new Error(`Worker error: ${error.message}`);
            });
        } else {
            // For files under 2GB, compress and send as single file
            await bot.sendMessage(chatId, '📦 Compressing file...');
            
            const zipPath = path.join(tempDir, `${fileName}.zip`);
            const output = createWriteStream(zipPath, { mode: 0o666 });
            const archive = archiver('zip', { zlib: { level: 9 } });
            
            archive.on('error', (err) => {
                throw err;
            });

            archive.pipe(output);
            archive.file(sanitizedSourcePath, { name: fileName });
            
            await archive.finalize();
            
            await bot.sendMessage(chatId, '📤 Sending compressed file...');
            await bot.sendDocument(chatId, zipPath, {
                caption: `${fileName}.zip`
            });
            
            // Clean up
            try {
                fs.unlinkSync(zipPath);
            } catch (unlinkError) {
                console.error('Failed to delete zip file:', unlinkError);
            }
        }

        // Clean up temp directory
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (rmError) {
            console.error('Failed to remove temp directory:', rmError);
        }

        await bot.sendMessage(chatId, '✅ File transfer completed successfully!');
    } catch (error) {
        console.error('Error handling completed torrent:', error);
        await bot.sendMessage(
            chatId, 
            `❌ Failed to send the downloaded file: ${error instanceof Error ? error.message : 'Unknown error'}\n` +
            'The file is still available in qBittorrent if you want to try again.'
        );
    }
}

// Utility functions
function formatSpeed(bytes: number): string {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let speed = bytes;
    let unitIndex = 0;
    while (speed >= 1024 && unitIndex < units.length - 1) {
        speed /= 1024;
        unitIndex++;
    }
    return `${speed.toFixed(2)} ${units[unitIndex]}`;
}

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

export const torrentCommand: Command = {
    name: 'torrent',
    description: 'Download a torrent using qBittorrent',
    execute: async (msg: TelegramBot.Message, bot: TelegramBot) => {
        const chatId = msg.chat.id;

        // Set user state to waiting for magnet URL
        userStates.set(chatId, 'waiting_for_magnet');

        await bot.sendMessage(
            chatId,
            '🧲 Please send me the magnet URL to download.\n\n' +
            'Make sure qBittorrent is running and properly configured.\n' +
            'Type /cancel to cancel the download.',
            { parse_mode: 'Markdown' }
        );
    }
}; 