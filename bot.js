const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const WebSocket = require('ws');
require('dotenv').config();

class TempEmailTelegramBot {
    constructor() {
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
        this.serverUrl = process.env.WEBHOOK_URL || 'http://localhost:3000';
        this.userStates = new Map();
        this.activeConnections = new Map();
        this.init();
    }

    init() {
        this.setupCommands();
        this.setupCallbacks();
        this.setupErrorHandling();
        console.log('🤖 Telegram Bot Started Successfully');
        console.log('📱 Bot is ready to receive messages');
    }

    setupCommands() {
        // Start command
        this.bot.onText(/\/start/, async (msg) => {
            const chatId = msg.chat.id;
            const firstName = msg.from.first_name || 'User';
            
            await this.sendWelcomeMessage(chatId, firstName);
        });

        // Help command
        this.bot.onText(/\/help/, async (msg) => {
            const chatId = msg.chat.id;
            
            const helpText = `
🔥 *Available Commands:*

🎯 /start - Start the bot
📧 /email - Get current email
🆕 /generate - Generate new email
📥 /inbox - Check inbox
♻️ /recover - Recover email
📊 /stats - View statistics
❓ /help - Show this help

💡 *Quick Access:*
Use the keyboard buttons below for quick actions!
            `;

            await this.bot.sendMessage(chatId, helpText, { 
                parse_mode: 'Markdown',
                reply_markup: this.getMainKeyboard()
            });
        });

        // Generate command
        this.bot.onText(/\/generate/, async (msg) => {
            const chatId = msg.chat.id;
            await this.handleGenerateEmail(chatId, msg.from.id);
        });

        // Email command
        this.bot.onText(/\/email/, async (msg) => {
            const chatId = msg.chat.id;
            await this.handleMyEmail(chatId, msg.from.id);
        });

        // Inbox command
        this.bot.onText(/\/inbox/, async (msg) => {
            const chatId = msg.chat.id;
            await this.handleInbox(chatId, msg.from.id);
        });

        // Recover command
        this.bot.onText(/\/recover/, async (msg) => {
            const chatId = msg.chat.id;
            await this.handleRecovery(chatId, msg.from.id);
        });

        // Stats command
        this.bot.onText(/\/stats/, async (msg) => {
            const chatId = msg.chat.id;
            await this.handleStats(chatId, msg.from.id);
        });
    }

    setupCallbacks() {
        // Handle text messages and keyboard buttons
        this.bot.on('message', async (msg) => {
            if (msg.text && !msg.text.startsWith('/')) {
                await this.handleTextMessage(msg);
            }
        });

        // Handle callback queries
        this.bot.on('callback_query', async (callbackQuery) => {
            await this.handleCallbackQuery(callbackQuery);
        });
    }

    setupErrorHandling() {
        this.bot.on('error', (error) => {
            console.error('❌ Telegram Bot Error:', error);
        });

        this.bot.on('polling_error', (error) => {
            console.error('❌ Polling Error:', error);
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
        });
    }

    async handleTextMessage(msg) {
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = msg.from.id;

        switch (text) {
            case '📧 My Email':
                await this.handleMyEmail(chatId, userId);
                break;
            case '🔄 Generate New':
                await this.handleGenerateEmail(chatId, userId);
                break;
            case '📥 Inbox':
                await this.handleInbox(chatId, userId);
                break;
            case '♻️ Recovery':
                await this.handleRecovery(chatId, userId);
                break;
            default:
                // Check if user is in recovery mode
                const userState = this.userStates.get(userId);
                if (userState && userState.action === 'waiting_recovery_email') {
                    await this.processRecoveryEmail(chatId, userId, text);
                } else {
                    await this.sendMainMenu(chatId);
                }
        }
    }

    async handleCallbackQuery(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;
        const userId = callbackQuery.from.id;
        const data = callbackQuery.data;

        try {
            await this.bot.answerCallbackQuery(callbackQuery.id);

            if (data.startsWith('read_msg_')) {
                const messageDbId = data.replace('read_msg_', '');
                await this.handleReadMessage(chatId, userId, messageDbId, messageId);
            } else if (data.startsWith('del_msg_')) {
                const messageDbId = data.replace('del_msg_', '');
                await this.handleDeleteMessage(chatId, userId, messageDbId, messageId);
            } else if (data === 'refresh_inbox') {
                await this.handleInbox(chatId, userId, messageId);
            } else if (data === 'back_to_inbox') {
                await this.handleInbox(chatId, userId, messageId);
            }
        } catch (error) {
            console.error('Callback query error:', error);
            await this.bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
        }
    }

    async sendWelcomeMessage(chatId, firstName) {
        const welcomeText = `😜 Hey ${firstName} Welcome To OUR BoT

🧑‍💻 BoT Created BY : @earning_tips009`;

        await this.bot.sendMessage(chatId, welcomeText, {
            reply_markup: this.getMainKeyboard()
        });
    }

    async handleGenerateEmail(chatId, userId) {
        const loadingMsg = await this.bot.sendMessage(chatId, '⏳ Generating new email...');

        try {
            const response = await axios.post(`${this.serverUrl}/api/generate`, {
                telegramUserId: userId
            });

            const { email, token } = response.data;

            // Store user email data
            this.userStates.set(userId, {
                email,
                token,
                lastUpdate: Date.now()
            });

            // Setup WebSocket connection for real-time updates
            this.setupWebSocketConnection(userId, email, token);

            await this.bot.deleteMessage(chatId, loadingMsg.message_id);
            
            const successText = `♻️ New Email Generated Successfully ✅

📬 Email ID : ${email} 👈`;

            await this.bot.sendMessage(chatId, successText, {
                reply_markup: this.getMainKeyboard()
            });

        } catch (error) {
            console.error('Generate email error:', error);
            await this.bot.editMessageText('❌ Failed to generate email. Please try again.', {
                chat_id: chatId,
                message_id: loadingMsg.message_id
            });
        }
    }

    async handleMyEmail(chatId, userId) {
        const userState = this.userStates.get(userId);
        
        if (!userState || !userState.email) {
            await this.bot.sendMessage(chatId, '❌ No active email found. Please generate a new email first.', {
                reply_markup: this.getMainKeyboard()
            });
            return;
        }

        const emailText = `📧 *Your Current Email:*

📬 ${userState.email}

⏰ *Status:* Active
🔄 *Auto-refresh:* Enabled`;

        await this.bot.sendMessage(chatId, emailText, {
            parse_mode: 'Markdown',
            reply_markup: this.getMainKeyboard()
        });
    }

    async handleInbox(chatId, userId, editMessageId = null) {
        const userState = this.userStates.get(userId);
        
        if (!userState || !userState.email || !userState.token) {
            const noEmailText = '❌ No active email found. Please generate a new email first.';
            
            if (editMessageId) {
                await this.bot.editMessageText(noEmailText, {
                    chat_id: chatId,
                    message_id: editMessageId
                });
            } else {
                await this.bot.sendMessage(chatId, noEmailText, {
                    reply_markup: this.getMainKeyboard()
                });
            }
            return;
        }

        const loadingText = editMessageId ? '⏳ Refreshing inbox...' : '⏳ Loading inbox...';
        
        let loadingMsg;
        if (editMessageId) {
            await this.bot.editMessageText(loadingText, {
                chat_id: chatId,
                message_id: editMessageId
            });
        } else {
            loadingMsg = await this.bot.sendMessage(chatId, loadingText);
        }

        try {
            const response = await axios.get(`${this.serverUrl}/api/inbox/${userState.email}?token=${userState.token}`);
            const messages = response.data;

            if (messages.length === 0) {
                const noMsgText = `📭 No messages in your inbox yet.

📬 Email: ${userState.email}
⏰ Waiting for incoming emails...`;

                if (editMessageId) {
                    await this.bot.editMessageText(noMsgText, {
                        chat_id: chatId,
                        message_id: editMessageId,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Refresh', callback_data: 'refresh_inbox' }
                            ]]
                        }
                    });
                } else {
                    await this.bot.editMessageText(noMsgText, {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Refresh', callback_data: 'refresh_inbox' }
                            ]]
                        }
                    });
                }
                return;
            }

            // Show first message details
            const firstMsg = messages[0];
            const messageText = `📩 New Mail Received In Your Email ID 🪧

📇 From : ${firstMsg.from}

🗒️ Subject : ${firstMsg.subject}

📅 Date : ${new Date(firstMsg.createdAt).toLocaleString()}

📧 Email : ${userState.email}`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '👀 Read Message', callback_data: `read_msg_${firstMsg.id}` },
                        { text: '🗑️ Delete', callback_data: `del_msg_${firstMsg.id}` }
                    ],
                    [{ text: '🔄 Refresh Inbox', callback_data: 'refresh_inbox' }]
                ]
            };

            // Add navigation if more messages exist
            if (messages.length > 1) {
                keyboard.inline_keyboard.unshift([
                    { text: `📨 Message 1 of ${messages.length}`, callback_data: 'msg_info' }
                ]);
            }

            if (editMessageId) {
                await this.bot.editMessageText(messageText, {
                    chat_id: chatId,
                    message_id: editMessageId,
                    reply_markup: keyboard
                });
            } else {
                await this.bot.editMessageText(messageText, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    reply_markup: keyboard
                });
            }

        } catch (error) {
            console.error('Inbox error:', error);
            const errorText = '❌ Failed to load inbox. Please try again later.';
            
            if (editMessageId) {
                await this.bot.editMessageText(errorText, {
                    chat_id: chatId,
                    message_id: editMessageId
                });
            } else if (loadingMsg) {
                await this.bot.editMessageText(errorText, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id
                });
            } else {
                await this.bot.sendMessage(chatId, errorText);
            }
        }
    }

    async handleReadMessage(chatId, userId, messageId, botMessageId) {
        const userState = this.userStates.get(userId);
        
        if (!userState || !userState.email || !userState.token) {
            await this.bot.editMessageText('❌ Session expired. Please generate a new email.', {
                chat_id: chatId,
                message_id: botMessageId
            });
            return;
        }

        try {
            const response = await axios.get(`${this.serverUrl}/api/message/${userState.email}/${messageId}?token=${userState.token}`);
            const message = response.data;

            const messageText = `📩 *Message Content:*

📇 *From:* ${message.from.address}
🗒️ *Subject:* ${message.subject || 'No Subject'}
📅 *Date:* ${new Date(message.createdAt).toLocaleString()}

💬 *Text:* ${message.text || message.html || 'No content available'}`;

            await this.bot.editMessageText(messageText, {
                chat_id: chatId,
                message_id: botMessageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🗑️ Delete Message', callback_data: `del_msg_${messageId}` },
                            { text: '⬅️ Back to Inbox', callback_data: 'back_to_inbox' }
                        ]
                    ]
                }
            });

        } catch (error) {
            console.error('Read message error:', error);
            await this.bot.editMessageText('❌ Failed to read message. Please try again.', {
                chat_id: chatId,
                message_id: botMessageId
            });
        }
    }

    async handleDeleteMessage(chatId, userId, messageId, botMessageId) {
        const userState = this.userStates.get(userId);
        
        if (!userState || !userState.email || !userState.token) {
            await this.bot.editMessageText('❌ Session expired. Please generate a new email.', {
                chat_id: chatId,
                message_id: botMessageId
            });
            return;
        }

        try {
            await axios.delete(`${this.serverUrl}/api/message/${userState.email}/${messageId}?token=${userState.token}`);

            await this.bot.editMessageText('✅ Message deleted successfully!', {
                chat_id: chatId,
                message_id: botMessageId,
                reply_markup: {
                    inline_keyboard: [[
                        { text: '⬅️ Back to Inbox', callback_data: 'back_to_inbox' }
                    ]]
                }
            });

        } catch (error) {
            console.error('Delete message error:', error);
            await this.bot.editMessageText('❌ Failed to delete message. Please try again.', {
                chat_id: chatId,
                message_id: botMessageId
            });
        }
    }

    async handleRecovery(chatId, userId) {
        const recoveryText = '✉️ Please enter your recovery email:';

        this.userStates.set(userId, {
            ...this.userStates.get(userId),
            action: 'waiting_recovery_email'
        });

        await this.bot.sendMessage(chatId, recoveryText, {
            reply_markup: {
                force_reply: true,
                input_field_placeholder: 'Enter your email address...'
            }
        });
    }

    async processRecoveryEmail(chatId, userId, emailAddress) {
        const loadingMsg = await this.bot.sendMessage(chatId, '⏳ Recovering email...');

        try {
            const response = await axios.post(`${this.serverUrl}/api/recover`, {
                email: emailAddress,
                telegramUserId: userId
            });

            const { email, token } = response.data;

            // Store recovered email data
            this.userStates.set(userId, {
                email,
                token,
                lastUpdate: Date.now()
            });

            // Setup WebSocket connection
            this.setupWebSocketConnection(userId, email, token);

            await this.bot.deleteMessage(chatId, loadingMsg.message_id);
            
            const successText = `♻️ Recovery Email Successfully ✅

📬 Recovery Email ID : ${email} 👈`;

            await this.bot.sendMessage(chatId, successText, {
                reply_markup: this.getMainKeyboard()
            });

        } catch (error) {
            console.error('Recovery error:', error);
            await this.bot.editMessageText('❌ Failed to recover email. Email not found or expired.', {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                reply_markup: this.getMainKeyboard()
            });
        }

        // Clear recovery state
        const currentState = this.userStates.get(userId) || {};
        delete currentState.action;
        this.userStates.set(userId, currentState);
    }

    async handleStats(chatId, userId) {
        try {
            const response = await axios.get(`${this.serverUrl}/api/user/${userId}/emails`);
            const emails = response.data;

            const statsText = `📊 *Your Statistics:*

📧 *Total Emails:* ${emails.length}
⚡ *Active Sessions:* ${this.activeConnections.has(userId) ? '1' : '0'}
🔄 *Real-time Updates:* ${this.activeConnections.has(userId) ? 'Enabled' : 'Disabled'}

📈 *Recent Activity:*
${emails.slice(0, 3).map(email => `• ${email.email} - ${new Date(email.last_access).toLocaleDateString()}`).join('\n') || 'No recent activity'}`;

            await this.bot.sendMessage(chatId, statsText, {
                parse_mode: 'Markdown',
                reply_markup: this.getMainKeyboard()
            });

        } catch (error) {
            console.error('Stats error:', error);
            await this.bot.sendMessage(chatId, '❌ Failed to load statistics.', {
                reply_markup: this.getMainKeyboard()
            });
        }
    }

    setupWebSocketConnection(userId, email, token) {
        // Close existing connection if any
        if (this.activeConnections.has(userId)) {
            this.activeConnections.get(userId).close();
        }

        try {
            const wsUrl = this.serverUrl.replace('http', 'ws').replace('https', 'wss');
            const ws = new WebSocket(wsUrl);

            ws.on('open', () => {
                console.log(`🔗 WebSocket connected for user ${userId}`);
                
                // Subscribe to email updates
                ws.send(JSON.stringify({
                    action: 'subscribe',
                    email,
                    token,
                    telegramUserId: userId
                }));

                this.activeConnections.set(userId, ws);
            });

            ws.on('message', async (data) => {
                try {
                    const message = JSON.parse(data);
                    await this.handleWebSocketMessage(userId, message);
                } catch (error) {
                    console.error('WebSocket message error:', error);
                }
            });

            ws.on('close', () => {
                console.log(`🔌 WebSocket disconnected for user ${userId}`);
                this.activeConnections.delete(userId);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.activeConnections.delete(userId);
            });

        } catch (error) {
            console.error('WebSocket setup error:', error);
        }
    }

    async handleWebSocketMessage(userId, message) {
        if (message.action === 'inbox_update' && message.messages && message.messages.length > 0) {
            const userState = this.userStates.get(userId);
            if (!userState) return;

            // Check if there are new messages
            const latestMessage = message.messages[0];
            const chatId = userId; // Assuming chat_id is same as user_id

            // Send notification about new email
            const notificationText = `🔔 *New Email Received!*

📇 From: ${latestMessage.from}
🗒️ Subject: ${latestMessage.subject}
📅 Time: ${new Date(latestMessage.createdAt).toLocaleString()}

📧 Email: ${message.email}`;

            try {
                await this.bot.sendMessage(chatId, notificationText, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '👀 View Message', callback_data: `read_msg_${latestMessage.id}` },
                            { text: '📥 Open Inbox', callback_data: 'refresh_inbox' }
                        ]]
                    }
                });
            } catch (error) {
                console.error('Failed to send notification:', error);
            }
        }
    }

    async sendMainMenu(chatId) {
        const menuText = `🎯 *Main Menu*

Choose an option from the keyboard below:`;

        await this.bot.sendMessage(chatId, menuText, {
            parse_mode: 'Markdown',
            reply_markup: this.getMainKeyboard()
        });
    }

    getMainKeyboard() {
        return {
            keyboard: [
                [{ text: "📧 My Email" }],
                [
                    { text: "🔄 Generate New" }, 
                    { text: "📥 Inbox" }
                ],
                [{ text: "♻️ Recovery" }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        };
    }
}

// Start the bot
const bot = new TempEmailTelegramBot();

// Export for testing
module.exports = TempEmailTelegramBot;
