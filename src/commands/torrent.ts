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

const MAX_ARCHIVE_SIZE = 1800 * 1024 * 1024; // 1.8GB to be safe
const SPLIT_SIZE = 1500 * 1024 * 1024; // 1.5GB for file splits

async function splitFile(filePath: string, outputDir: string, originalName: string): Promise<string[]> {
    const stats = await fs.promises.stat(filePath);
    const totalParts = Math.ceil(stats.size / SPLIT_SIZE);
    const parts: string[] = [];

    for (let i = 0; i < totalParts; i++) {
        const partPath = path.join(outputDir, `${originalName}.part${i + 1}`);
        const writeStream = createWriteStream(partPath);
        const readStream = createReadStream(filePath, {
            start: i * SPLIT_SIZE,
            end: Math.min((i + 1) * SPLIT_SIZE - 1, stats.size - 1)
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

        // For single files under 1.8GB, send directly
        if (accessibleFiles.length === 1 && accessibleFiles[0].size < MAX_ARCHIVE_SIZE) {
            const file = accessibleFiles[0];
            await bot.sendMessage(chatId, `📤 Sending file directly: ${file.filename} (${formatSize(file.size)})...`);
            await bot.sendDocument(chatId, file.path, {
                caption: file.filename
            });
            await bot.sendMessage(chatId, '✅ File sent successfully!');
            return;
        }

        // Sort files by size in descending order
        accessibleFiles.sort((a, b) => b.size - a.size);

        const torrentName = torrent.name.replace(/[<>:"/\\|?*]/g, '_').replace(/[\u{1F300}-\u{1F9FF}]/gu, '').trim();
        let currentArchiveSize = 0;
        let currentArchiveFiles: TorrentFile[] = [];
        let archiveNumber = 1;
        const totalArchives = Math.ceil(totalSize / MAX_ARCHIVE_SIZE);

        // Group files into archives
        for (const file of accessibleFiles) {
            if (file.size > MAX_ARCHIVE_SIZE) {
                // Handle large individual files separately
                await bot.sendMessage(chatId, `📦 Processing large file: ${file.filename} (${formatSize(file.size)})...`);
                const splitPath = path.join(tempDir, `${file.filename}.split`);
                await fs.promises.mkdir(splitPath, { recursive: true });
                
                const parts = await splitFile(file.path, splitPath, file.filename);
                
                // Send each part
                for (let i = 0; i < parts.length; i++) {
                    const partPath = parts[i];
                    const partStats = await fs.promises.stat(partPath);
                    await bot.sendMessage(chatId, `📤 Sending part ${i + 1} of ${parts.length} (${formatSize(partStats.size)})...`);
                    await bot.sendDocument(chatId, partPath, {
                        caption: `${file.filename} - Part ${i + 1} of ${parts.length}`
                    });
                }
                continue;
            }

            if (currentArchiveSize + file.size > MAX_ARCHIVE_SIZE) {
                // Create and send current archive
                if (currentArchiveFiles.length > 0) {
                    await createAndSendArchive(
                        currentArchiveFiles,
                        tempDir,
                        `${torrentName}.part${archiveNumber}`,
                        archiveNumber,
                        totalArchives,
                        bot,
                        chatId
                    );
                }
                currentArchiveFiles = [];
                currentArchiveSize = 0;
                archiveNumber++;
            }

            currentArchiveFiles.push(file);
            currentArchiveSize += file.size;
        }

        // Send remaining files in the last archive
        if (currentArchiveFiles.length > 0) {
            await createAndSendArchive(
                currentArchiveFiles,
                tempDir,
                `${torrentName}.part${archiveNumber}`,
                archiveNumber,
                totalArchives,
                bot,
                chatId
            );
        }

        await bot.sendMessage(chatId, '✅ All files sent successfully!');
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

async function createAndSendArchive(
    files: TorrentFile[],
    tempDir: string,
    archiveName: string,
    partNumber: number,
    totalParts: number,
    bot: TelegramBot,
    chatId: number
): Promise<void> {
    const zipPath = path.join(tempDir, `${archiveName}.zip`);
    await bot.sendMessage(chatId, `📦 Creating archive part ${partNumber} of ${totalParts}...`);

    const output = createWriteStream(zipPath);
    const archive = archiver('zip', {
        zlib: { level: 6 },
        store: false
    });

    archive.pipe(output);

    // Add files to archive
    for (const file of files) {
        archive.file(file.path, { name: file.filename });
    }

    await archive.finalize();

    // Send the archive
    const stats = await fs.promises.stat(zipPath);
    await bot.sendMessage(chatId, `📤 Sending archive part ${partNumber} of ${totalParts} (${formatSize(stats.size)})...`);
    await bot.sendDocument(chatId, zipPath, {
        caption: `${archiveName} (Part ${partNumber} of ${totalParts})`
    });
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