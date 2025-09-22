const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const { EmailService } = require('./server');
require('dotenv').config();

// Bot configuration
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Database connection
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// User sessions storage
const userSessions = new Map();

// Recovery mode storage
const recoveryMode = new Map();

// Keyboard layout
const keyboard = {
    keyboard: [
        [
            { text: "📧 My Email" }
        ],
        [
            { text: "🔄 Generate New" },
            { text: "📥 Inbox" }
        ],
        [
            { text: "♻️ Recovery" }
        ]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
};

// Helper functions
async function saveUserSession(userId, email, token, password) {
    try {
        const connection = await pool.getConnection();
        await connection.execute(
            `INSERT INTO user_sessions (user_id, email, token, password, created_at) 
             VALUES (?, ?, ?, ?, NOW()) 
             ON DUPLICATE KEY UPDATE token = ?, password = ?, updated_at = NOW()`,
            [userId, email, token, password, token, password]
        );
        connection.release();
        
        userSessions.set(userId, { email, token, password });
    } catch (error) {
        console.error('Error saving user session:', error);
    }
}

async function getUserSession(userId) {
    try {
        if (userSessions.has(userId)) {
            return userSessions.get(userId);
        }

        const connection = await pool.getConnection();
        const [rows] = await connection.execute(
            "SELECT email, token, password FROM user_sessions WHERE user_id = ?",
            [userId]
        );
        connection.release();

        if (rows.length > 0) {
            const session = rows[0];
            userSessions.set(userId, session);
            return session;
        }
        return null;
    } catch (error) {
        console.error('Error getting user session:', error);
        return null;
    }
}

async function formatMessageForTelegram(message) {
    const date = new Date(message.createdAt).toLocaleString();
    let text = message.text || 'No text content';
    
    // Clean HTML if present
    if (message.html) {
        text = message.html
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim();
    }

    // Truncate long messages
    if (text.length > 500) {
        text = text.substring(0, 500) + '...';
    }

    return `📩 New Mail Received In Your Email ID 🪧

📇 From : ${message.from.address}

🗒️ Subject : ${message.subject || 'No Subject'}

💬 Text : *${text}*`;
}

// Bot event handlers
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || 'User';
    
    const welcomeMessage = `😜 Hey ${firstName} Welcome To OUR BoT

🧑‍💻 BoT Created BY : @earning_tips009`;

    await bot.sendMessage(chatId, welcomeMessage, {
        reply_markup: keyboard,
        parse_mode: 'Markdown'
    });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // Skip command messages
    if (text && text.startsWith('/')) return;

    try {
        // Handle recovery mode
        if (recoveryMode.has(userId)) {
            if (text && text.includes('@')) {
                try {
                    const result = await EmailService.recoverEmail(text);
                    await saveUserSession(userId, result.email, result.token, '');
                    recoveryMode.delete(userId);

                    await bot.sendMessage(chatId, `♻️ Recovery Email Successfully ✅

📬 Recovery Email ID : ${result.email} 👈`, {
                        reply_markup: keyboard,
                        parse_mode: 'Markdown'
                    });
                } catch (error) {
                    await bot.sendMessage(chatId, '❌ Email not found or recovery failed. Please try again.', {
                        reply_markup: keyboard
                    });
                    recoveryMode.delete(userId);
                }
            } else {
                await bot.sendMessage(chatId, '❌ Please enter a valid email address.', {
                    reply_markup: keyboard
                });
            }
            return;
        }

        // Handle button clicks
        switch (text) {
            case '📧 My Email':
                const session = await getUserSession(userId);
                if (session && session.email) {
                    await bot.sendMessage(chatId, `📬 Your Current Email ID : ${session.email} 👈`, {
                        reply_markup: keyboard,
                        parse_mode: 'Markdown'
                    });
                } else {
                    await bot.sendMessage(chatId, '❌ No active email found. Please generate a new email first.', {
                        reply_markup: keyboard
                    });
                }
                break;

            case '🔄 Generate New':
                try {
                    const result = await EmailService.generateEmail();
                    await saveUserSession(userId, result.email, result.token, result.password);

                    await bot.sendMessage(chatId, `♻️ New Email Generated Successfully ✅

📬 Email ID : ${result.email} 👈`, {
                        reply_markup: keyboard,
                        parse_mode: 'Markdown'
                    });
                } catch (error) {
                    await bot.sendMessage(chatId, '❌ Failed to generate email. Please try again later.', {
                        reply_markup: keyboard
                    });
                }
                break;

            case '📥 Inbox':
                const userSession = await getUserSession(userId);
                if (!userSession || !userSession.email || !userSession.token) {
                    await bot.sendMessage(chatId, '❌ No active email found. Please generate an email first.', {
                        reply_markup: keyboard
                    });
                    return;
                }

                try {
                    const inboxResult = await EmailService.getInbox(userSession.token, userSession.email);
                    
                    if (inboxResult.messages && inboxResult.messages.length > 0) {
                        // Get the latest message
                        const latestMessage = inboxResult.messages[0];
                        
                        // Get full message content
                        const fullMessage = await EmailService.readMessage(
                            inboxResult.token, 
                            latestMessage.id, 
                            userSession.email
                        );

                        const formattedMessage = await formatMessageForTelegram(fullMessage);
                        await bot.sendMessage(chatId, formattedMessage, {
                            reply_markup: keyboard,
                            parse_mode: 'Markdown'
                        });

                        // Update token if refreshed
                        if (inboxResult.token !== userSession.token) {
                            await saveUserSession(userId, userSession.email, inboxResult.token, userSession.password);
                        }
                    } else {
                        await bot.sendMessage(chatId, '📭 No messages found in your inbox.', {
                            reply_markup: keyboard
                        });
                    }
                } catch (error) {
                    console.error('Inbox error:', error);
                    await bot.sendMessage(chatId, '❌ Failed to fetch inbox. Please try again.', {
                        reply_markup: keyboard
                    });
                }
                break;

            case '♻️ Recovery':
                recoveryMode.set(userId, true);
                await bot.sendMessage(chatId, '✉️ Please enter your recovery email:', {
                    reply_markup: {
                        remove_keyboard: true
                    }
                });
                break;

            default:
                // Default response for unrecognized input
                await bot.sendMessage(chatId, 'Please use the buttons below to interact with the bot.', {
                    reply_markup: keyboard
                });
                break;
        }
    } catch (error) {
        console.error('Bot message error:', error);
        await bot.sendMessage(chatId, '❌ Something went wrong. Please try again.', {
            reply_markup: keyboard
        });
    }
});

// Error handling
bot.on('error', (error) => {
    console.error('Telegram Bot Error:', error);
});

bot.on('polling_error', (error) => {
    console.error('Telegram Polling Error:', error);
});

// Real-time inbox monitoring
async function startInboxMonitoring() {
    console.log('🔄 Starting real-time inbox monitoring...');
    
    setInterval(async () => {
        try {
            // Check all active user sessions for new messages
            for (const [userId, session] of userSessions.entries()) {
                if (session.email && session.token) {
                    try {
                        const inboxResult = await EmailService.getInbox(session.token, session.email);
                        
                        // Check for new unread messages
                        const unreadMessages = inboxResult.messages.filter(msg => !msg.seen);
                        
                        if (unreadMessages.length > 0) {
                            const latestMessage = unreadMessages[0];
                            
                            // Get full message content
                            const fullMessage = await EmailService.readMessage(
                                inboxResult.token, 
                                latestMessage.id, 
                                session.email
                            );

                            const formattedMessage = await formatMessageForTelegram(fullMessage);
                            
                            // Send notification to user
                            await bot.sendMessage(userId, `🔔 New Message Alert!

${formattedMessage}`, {
                                reply_markup: keyboard,
                                parse_mode: 'Markdown'
                            });

                            // Update token if refreshed
                            if (inboxResult.token !== session.token) {
                                await saveUserSession(userId, session.email, inboxResult.token, session.password);
                            }
                        }
                    } catch (error) {
                        console.error(`Error monitoring inbox for user ${userId}:`, error);
                    }
                }
            }
        } catch (error) {
            console.error('Inbox monitoring error:', error);
        }
    }, 30000); // Check every 30 seconds
}

// Initialize database tables
async function initializeDatabase() {
    try {
        const connection = await pool.getConnection();
        
        // Create user_sessions table if it doesn't exist
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_sessions (
                user_id BIGINT PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                token TEXT NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        connection.release();
        console.log('✅ Database tables initialized');
    } catch (error) {
        console.error('❌ Database initialization error:', error);
    }
}

// Start the bot
async function startBot() {
    console.log('🤖 Telegram Bot starting...');
    await initializeDatabase();
    await startInboxMonitoring();
    console.log('🚀 Telegram Bot is running!');
}

startBot();

module.exports = bot;
