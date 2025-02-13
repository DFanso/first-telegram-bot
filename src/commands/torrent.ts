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
    let tempDir: string | undefined;
    try {
        await bot.sendMessage(chatId, '✅ Download complete! Processing files...');
        
        // Get all files from qBittorrent
        const files = await qbittorrent.downloadFile(torrent.hash);
        
        // Create temp directory for zip files only
        tempDir = path.join(process.env.TEMP || process.env.TMP || path.join(process.cwd(), 'temp'), 'telegram-bot', Date.now().toString());
        await fs.promises.mkdir(tempDir, { recursive: true });

        // Calculate total size of all files
        let totalSize = 0;
        const accessibleFiles = [];
        for (const fileInfo of files) {
            try {
                await fs.promises.access(fileInfo.path, fs.constants.R_OK);
                const stats = await fs.promises.stat(fileInfo.path);
                totalSize += stats.size;
                accessibleFiles.push(fileInfo);
            } catch (accessError) {
                console.error('File access error:', accessError);
                await bot.sendMessage(chatId, `⚠️ Skipping inaccessible file: ${fileInfo.filename}`);
            }
        }

        if (accessibleFiles.length === 0) {
            throw new Error('No accessible files found in torrent');
        }

        const PART_SIZE = 2 * 1024 * 1024 * 1024; // 2GB in bytes
        const torrentName = torrent.name.replace(/[<>:"/\\|?*]/g, '_').replace(/[\u{1F300}-\u{1F9FF}]/gu, '').trim();

        // If total size is larger than 2GB, split into parts
        if (totalSize > PART_SIZE) {
            await bot.sendMessage(chatId, '📦 Total size is larger than 2GB. Creating split archives...');
            
            // Create a worker for compression and splitting
            const worker = new Worker(`
                const { parentPort, workerData } = require('worker_threads');
                const fs = require('fs');
                const archiver = require('archiver');
                const path = require('path');

                async function compressFiles() {
                    const { files, tempDir, PART_SIZE, torrentName } = workerData;
                    let currentArchive = null;
                    let currentSize = 0;
                    let partNum = 1;
                    const parts = [];
                    let totalProcessed = 0;
                    const totalSize = files.reduce((sum, f) => sum + fs.statSync(f.path).size, 0);

                    try {
                        // Function to create new archive
                        function createNewArchive() {
                            const archive = archiver('zip', { zlib: { level: 9 } });
                            const partPath = path.join(tempDir, \`\${torrentName}.part\${partNum}.zip\`);
                            const output = fs.createWriteStream(partPath);

                            return new Promise((resolve, reject) => {
                                output.on('close', () => resolve(partPath));
                                archive.on('error', reject);
                                archive.on('warning', console.warn);
                                archive.pipe(output);
                            }).then(path => {
                                parts.push(path);
                                partNum++;
                                currentSize = 0;
                                return archive;
                            });
                        }

                        // Create first archive
                        currentArchive = await createNewArchive();

                        // Process each file
                        for (const file of files) {
                            const stats = fs.statSync(file.path);
                            
                            // If single file is larger than part size, need to split it
                            if (stats.size > PART_SIZE) {
                                throw new Error(\`File \${file.filename} is too large (\${stats.size} bytes) to process\`);
                            }

                            // If current archive would exceed part size, create new one
                            if (currentSize + stats.size > PART_SIZE) {
                                await currentArchive.finalize();
                                currentArchive = await createNewArchive();
                            }

                            // Add file to current archive
                            currentArchive.file(file.path, { name: file.filename });
                            currentSize += stats.size;
                            totalProcessed += stats.size;

                            // Report progress
                            parentPort.postMessage({ 
                                type: 'progress',
                                progress: (totalProcessed / totalSize) * 100,
                                currentPart: partNum - 1,
                                totalFiles: files.length
                            });
                        }

                        // Finalize last archive
                        if (currentArchive) {
                            await currentArchive.finalize();
                        }

                        parentPort.postMessage({ type: 'complete', parts });
                    } catch (error) {
                        parentPort.postMessage({ 
                            type: 'error', 
                            error: \`Compression error: \${error.message}\` 
                        });
                    }
                }

                compressFiles().catch(error => {
                    parentPort.postMessage({ 
                        type: 'error', 
                        error: \`Worker error: \${error.message}\` 
                    });
                });
            `, { eval: true, workerData: { 
                files: accessibleFiles,
                tempDir, 
                PART_SIZE,
                torrentName
            }});

            // Handle worker messages
            worker.on('message', async (message) => {
                if (message.type === 'progress') {
                    await bot.sendMessage(
                        chatId, 
                        `📦 Creating archive part ${message.currentPart}, overall progress: ${Math.round(message.progress)}%`
                    );
                } else if (message.type === 'complete') {
                    const parts = message.parts;
                    await bot.sendMessage(chatId, `✅ Created ${parts.length} archive parts. Sending files...`);
                    
                    // Send each part
                    for (let i = 0; i < parts.length; i++) {
                        try {
                            const partPath = parts[i];
                            await bot.sendDocument(chatId, partPath, {
                                caption: `${torrentName} - Part ${i + 1} of ${parts.length}`
                            });
                        } catch (sendError: any) {
                            console.error(`Failed to send part ${i + 1}:`, sendError);
                            throw new Error(`Failed to send part ${i + 1}: ${sendError?.message || 'Unknown error'}`);
                        }
                    }
                    
                    await bot.sendMessage(chatId, '✅ All archive parts sent successfully!');
                } else if (message.type === 'error') {
                    throw new Error(message.error);
                }
            });

            // Handle worker errors
            worker.on('error', (error) => {
                throw new Error(`Worker error: ${error.message}`);
            });
        } else {
            // For total size under 2GB, create single archive
            await bot.sendMessage(chatId, '📦 Creating archive of all files...');
            
            const zipPath = path.join(tempDir, `${torrentName}.zip`);
            const output = createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });
            
            archive.on('error', (err) => {
                throw err;
            });

            // Set up progress handling
            archive.on('progress', (progress) => {
                if (progress.entries.processed % 10 === 0) { // Update every 10 files
                    bot.sendMessage(
                        chatId,
                        `📦 Archived ${progress.entries.processed} of ${progress.entries.total} files...`
                    ).catch(console.error);
                }
            });

            archive.pipe(output);

            // Add all files to archive
            for (const fileInfo of accessibleFiles) {
                archive.file(fileInfo.path, { name: fileInfo.filename });
            }
            
            await archive.finalize();
            
            await bot.sendMessage(chatId, '📤 Sending archive...');
            await bot.sendDocument(chatId, zipPath, {
                caption: `${torrentName}.zip`
            });
        }

        await bot.sendMessage(chatId, '✅ All files processed successfully!');
    } catch (error) {
        console.error('Error handling completed torrent:', error);
        await bot.sendMessage(
            chatId, 
            `❌ Failed to process files: ${error instanceof Error ? error.message : 'Unknown error'}\n` +
            'The files are still available in qBittorrent if you want to try again.'
        );
    } finally {
        // Clean up temp directory if it was created
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (rmError) {
                console.error('Failed to remove temp directory:', rmError);
            }
        }
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