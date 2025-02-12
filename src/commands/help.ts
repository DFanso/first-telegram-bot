import TelegramBot from 'node-telegram-bot-api';
import { Command } from '../types';
import { commands } from './index';

export const helpCommand: Command = {
    name: 'help',
    description: 'Show all available commands and their descriptions',
    execute: async (msg: TelegramBot.Message, bot: TelegramBot) => {
        const chatId = msg.chat.id;
        
        let helpMessage = '🤖 *Available Commands*\n\n';
        commands.forEach(cmd => {
            helpMessage += `/${cmd.name} - ${cmd.description}\n`;
        });
        
        helpMessage += '\n💡 *Tips:*\n';
        helpMessage += '• Use /videos to browse and select available videos\n';
        helpMessage += '• Videos larger than 2GB will be automatically split\n';
        helpMessage += '• Progress tracking is available for both uploads and downloads';

        await bot.sendMessage(chatId, helpMessage, {
            parse_mode: 'Markdown'
        });
    }
}; 