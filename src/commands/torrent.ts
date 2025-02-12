import TelegramBot from 'node-telegram-bot-api';
import { Command } from '../types';
import { config } from '../config';
import path from 'path';
import { sendVideo } from '../utils/sendVideo';
import { qbittorrent } from '../services/qbittorrent';

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

            // Add torrent to qBittorrent
            await qbittorrent.addMagnet(magnetUrl);
            
            // Get torrent info
            const torrents = await qbittorrent.getTorrents();
            const torrent = torrents.find(t => t.magnet_uri === magnetUrl);

            if (!torrent) {
                throw new Error('Failed to add torrent');
            }

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
            await bot.sendMessage(chatId, '❌ Failed to add torrent. Please try again later.');
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

        // Update progress message
        const progressText = `📥 Downloading: ${torrent.name}\n` +
            `Progress: ${Math.round(torrent.progress * 100)}%\n` +
            `Speed: ${formatSpeed(torrent.dlspeed)}\n` +
            `Size: ${formatSize(torrent.size)}\n` +
            `Status: ${torrent.state}`;

        await bot.editMessageText(progressText, {
            chat_id: progress.chatId,
            message_id: progress.messageId
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
        const filePath = torrent.content_path || path.join(config.QBITTORRENT_DOWNLOAD_PATH, torrent.name);
        await bot.sendMessage(chatId, '✅ Download complete! Sending file...');
        
        // Send the video file
        await sendVideo(bot, chatId, filePath, true);

        // Clean up
        await qbittorrent.deleteTorrent(torrent.hash, true);
    } catch (error) {
        console.error('Error handling completed torrent:', error);
        await bot.sendMessage(chatId, '❌ Failed to send the downloaded file.');
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