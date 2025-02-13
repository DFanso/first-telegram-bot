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

interface TorrentFile {
    path: string;
    filename: string;
    size: number;
}

const PART_SIZE = 512 * 1024; // 512KB as recommended by Telegram API
const MAX_FILE_SIZE = 2000 * 1024 * 1024; // 2000MB (2GB)

async function splitFile(filePath: string, outputDir: string, originalName: string): Promise<string[]> {
    const stats = await fs.promises.stat(filePath);
    const totalParts = Math.ceil(stats.size / PART_SIZE);
    const parts: string[] = [];

    for (let i = 0; i < totalParts; i++) {
        const partPath = path.join(outputDir, `${originalName}.part${i + 1}`);
        const writeStream = createWriteStream(partPath);
        const readStream = createReadStream(filePath, {
            start: i * PART_SIZE,
            end: Math.min((i + 1) * PART_SIZE - 1, stats.size - 1)
        });

        await pipeline(readStream, writeStream);
        parts.push(partPath);
    }

    return parts;
}

async function handleCompletedTorrent(torrent: any, bot: TelegramBot, chatId: number) {
    let tempDir: string | undefined;
    try {
        await bot.sendMessage(chatId, '✅ Download complete! Processing files...');
        
        // Get all files from qBittorrent
        const files = await qbittorrent.downloadFile(torrent.hash);
        
        // Create temp directory
        tempDir = path.join(process.env.TEMP || process.env.TMP || path.join(process.cwd(), 'temp'), 'telegram-bot', Date.now().toString());
        await fs.promises.mkdir(tempDir, { recursive: true });

        // Calculate total size and filter accessible files
        let totalSize = 0;
        const accessibleFiles: TorrentFile[] = [];
        for (const fileInfo of files) {
            try {
                await fs.promises.access(fileInfo.path, fs.constants.R_OK);
                const stats = await fs.promises.stat(fileInfo.path);
                totalSize += stats.size;
                accessibleFiles.push({...fileInfo, size: stats.size});
            } catch (accessError) {
                console.error('File access error:', accessError);
                await bot.sendMessage(chatId, `⚠️ Skipping inaccessible file: ${fileInfo.filename}`);
            }
        }

        if (accessibleFiles.length === 0) {
            throw new Error('No accessible files found in torrent');
        }

        // For single files under 512KB, send directly
        if (accessibleFiles.length === 1 && accessibleFiles[0].size <= PART_SIZE) {
            const file = accessibleFiles[0];
            await bot.sendMessage(chatId, `📤 Sending file directly: ${file.filename} (${formatSize(file.size)})...`);
            await bot.sendDocument(chatId, file.path, {
                caption: file.filename
            });
            await bot.sendMessage(chatId, '✅ File sent successfully!');
            return;
        }

        // Create archive
        const torrentName = torrent.name.replace(/[<>:"/\\|?*]/g, '_').replace(/[\u{1F300}-\u{1F9FF}]/gu, '').trim();
        const zipPath = path.join(tempDir, `${torrentName}.zip`);
        
        await bot.sendMessage(chatId, '📦 Creating archive of all files...');
        
        const output = createWriteStream(zipPath);
        const archive = archiver('zip', { 
            zlib: { level: 6 },
            store: false
        });

        archive.pipe(output);

        // Add all files to archive
        for (const fileInfo of accessibleFiles) {
            archive.file(fileInfo.path, { name: fileInfo.filename });
        }

        await archive.finalize();

        // Get archive size
        const zipStats = await fs.promises.stat(zipPath);
        if (zipStats.size > MAX_FILE_SIZE) {
            throw new Error(`Archive size (${formatSize(zipStats.size)}) exceeds 2GB limit`);
        }

        // For files larger than 512KB, split into parts
        if (zipStats.size > PART_SIZE) {
            await bot.sendMessage(chatId, `📤 Splitting archive into ${Math.ceil(zipStats.size / PART_SIZE)} parts...`);
            const parts = await splitFile(zipPath, tempDir, torrentName);
            
            for (let i = 0; i < parts.length; i++) {
                const partPath = parts[i];
                const partStats = await fs.promises.stat(partPath);
                await bot.sendMessage(chatId, `📤 Sending part ${i + 1} of ${parts.length} (${formatSize(partStats.size)})...`);
                
                await bot.sendDocument(chatId, partPath, {
                    caption: `${torrentName} - Part ${i + 1} of ${parts.length}`
                });
            }
        } else {
            // Send small archive directly
            await bot.sendMessage(chatId, `📤 Sending archive (${formatSize(zipStats.size)})...`);
            await bot.sendDocument(chatId, zipPath, {
                caption: torrentName
            });
        }

        await bot.sendMessage(chatId, '✅ Archive sent successfully!');
    } catch (error) {
        console.error('Error handling completed torrent:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await bot.sendMessage(
            chatId, 
            '❌ Failed to process files: ' + errorMessage + '\n' +
            'The files are still available in qBittorrent if you want to try again.'
        );
    } finally {
        // Clean up temp directory
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (rmError) {
                console.error('Failed to remove temp directory:', rmError);
            }
        }
    }
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