import TelegramBot from 'node-telegram-bot-api';

// Replace 'YOUR_TELEGRAM_BOT_TOKEN' with your actual bot token
const token = 'YOUR_TELEGRAM_BOT_TOKEN';

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });

// Listen for any kind of message
bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  // Send a message to the chat acknowledging receipt of their message
  bot.sendMessage(chatId, 'Hello, world!');
});
