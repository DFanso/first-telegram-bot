import TelegramBot from 'node-telegram-bot-api';
import { commands } from '../commands';

export async function handleMessage(msg: TelegramBot.Message, bot: TelegramBot) {
  if (!msg.text) return;

  const command = commands.find(cmd => msg.text?.startsWith(`/${cmd.name}`));
  
  if (command) {
    await command.execute(msg, bot);
  } else {
    // Handle non-command messages
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, 'Unknown command. Try /start');
  }
} 