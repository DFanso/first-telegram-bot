import TelegramBot from 'node-telegram-bot-api';
import { commands } from '../commands';
import { handleDownloadInput } from '../commands/download';

export async function handleMessage(msg: TelegramBot.Message, bot: TelegramBot) {
    try {
        // First check if it's a download input
        if (await handleDownloadInput(msg, bot)) {
            return;
        }

        // Handle commands
        if (msg.text?.startsWith('/')) {
            const commandName = msg.text.split(' ')[0].substring(1);
            const command = commands.find(cmd => cmd.name === commandName);
            
            if (command) {
                await command.execute(msg, bot);
            }
        }
    } catch (error) {
        console.error('Error handling message:', error);
    }
} 