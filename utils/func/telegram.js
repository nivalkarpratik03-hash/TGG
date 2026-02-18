const TelegramBot = require('node-telegram-bot-api');
/////////////------------pgfbot
// const telegramtoken ="8390227157:AAFYQ2eWFAJdm9P8me9Nk2voYe00Mn33dSU"
const telegramtoken ="8299096501:AAFy5VTAXhPfPw1CSmFegmy_xkDsupT1Acg"
/////////////------------ogbot
// const telegramtoken = '8199688040:AAHGqr4cECCMb9kd4qXNM5bKAXXrqj8shQk';
/////////////------------pnlbot
// const telegramtoken = "7764791634:AAGGwGa6Sl7jNauuQvgnTXRTVixikBZCb-g";

const bot = new TelegramBot(telegramtoken, { polling: false });

  
module.exports = bot