import TelegramBot from 'node-telegram-bot-api';
import { config } from './config';
import { handleMessage } from './handlers/messageHandler';
import { handleCallback } from './handlers/callbackHandler';
import { commands } from './commands';

const bot = new TelegramBot(config.token, { 
  polling: true,
  baseApiUrl: config.baseApiUrl
});

// Register bot commands
async function registerCommands() {
  try {
    const commandsList = commands.map(cmd => ({
      command: cmd.name,
      description: cmd.description
    }));
    
    await bot.setMyCommands(commandsList);
    console.log('Bot commands registered successfully');
  } catch (error) {
    console.error('Error registering bot commands:', error);
  }
}

// Initialize bot
async function initBot() {
  await registerCommands();
  console.log('Bot is running on local API server:', config.baseApiUrl);
}

bot.on('message', async (msg) => {
  try {
    await handleMessage(msg, bot);
  } catch (error) {
    console.error('Error handling message:', error);
  }
});

bot.on('callback_query', async (callbackQuery) => {
  try {
    await handleCallback(callbackQuery, bot);
  } catch (error) {
    console.error('Error handling callback:', error);
  }
});

initBot();
