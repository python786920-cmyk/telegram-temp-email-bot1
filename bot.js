const { Telegraf } = require('telegraf');
const mysql = require('mysql2/promise');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Database configuration
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};

// Create database connection
async function createConnection() {
    return await mysql.createConnection(dbConfig);
}

// Initialize database table
async function initDatabase() {
    const connection = await createConnection();
    
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS emails (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT NOT NULL,
            email VARCHAR(255) NOT NULL,
            password VARCHAR(255) NOT NULL,
            token VARCHAR(255) NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_access DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user_id (user_id)
        )
    `;
    
    await connection.execute(createTableQuery);
    await connection.end();
    console.log('Database initialized');
}

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

// Mail.tm API functions
class MailTMAPI {
    constructor() {
        this.baseURL = 'https://api.mail.tm';
    }

    async getDomains() {
        const response = await axios.get(`${this.baseURL}/domains`);
        return response.data['hydra:member'];
    }

    async createAccount(email, password) {
        const response = await axios.post(`${this.baseURL}/accounts`, {
            address: email,
            password: password
        });
        return response.data;
    }

    async getToken(email, password) {
        const response = await axios.post(`${this.baseURL}/token`, {
            address: email,
            password: password
        });
        return response.data.token;
    }

    async getMessages(token) {
        const response = await axios.get(`${this.baseURL}/messages`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        return response.data['hydra:member'];
    }

    async getMessage(messageId, token) {
        const response = await axios.get(`${this.baseURL}/messages/${messageId}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        return response.data;
    }
}

const mailAPI = new MailTMAPI();

// Generate random password
function generatePassword() {
    return Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
}

// Store user session
const userSessions = new Map();

// Start command
bot.start((ctx) => {
    const message = `😜 Hey ${ctx.from.first_name} Welcome To OUR BoT

🧑‍💻 BoT Created BY : @earning_tips009`;
    
    ctx.reply(message, { reply_markup: keyboard });
});

// Handle "📧 My Email" button
bot.hears('📧 My Email', async (ctx) => {
    const userId = ctx.from.id;
    const connection = await createConnection();
    
    try {
        const [rows] = await connection.execute(
            'SELECT * FROM emails WHERE user_id = ? ORDER BY last_access DESC LIMIT 1',
            [userId]
        );
        
        if (rows.length > 0) {
            const email = rows[0];
            await connection.execute(
                'UPDATE emails SET last_access = NOW() WHERE id = ?',
                [email.id]
            );
            
            ctx.reply(`📧 Your Current Email:\n\n📬 Email ID : ${email.email} 👈`, 
                { reply_markup: keyboard });
        } else {
            ctx.reply('❌ No active email found. Please generate a new one.', 
                { reply_markup: keyboard });
        }
    } catch (error) {
        console.error('Error fetching email:', error);
        ctx.reply('❌ Error fetching email. Please try again.', { reply_markup: keyboard });
    } finally {
        await connection.end();
    }
});

// Handle "🔄 Generate New" button
bot.hears('🔄 Generate New', async (ctx) => {
    const userId = ctx.from.id;
    const connection = await createConnection();
    
    try {
        // Get available domains
        const domains = await mailAPI.getDomains();
        if (domains.length === 0) {
            throw new Error('No domains available');
        }
        
        const domain = domains[0].domain;
        const username = Math.random().toString(36).substring(2, 10);
        const email = `${username}@${domain}`;
        const password = generatePassword();
        
        // Create account
        await mailAPI.createAccount(email, password);
        
        // Get token
        const token = await mailAPI.getToken(email, password);
        
        // Store in database
        await connection.execute(
            'INSERT INTO emails (user_id, email, password, token) VALUES (?, ?, ?, ?)',
            [userId, email, password, token]
        );
        
        // Store in session
        userSessions.set(userId, { email, password, token });
        
        const message = `♻️ New Email Generated Successfully ✅

📬 Email ID : ${email} 👈`;
        
        ctx.reply(message, { reply_markup: keyboard });
        
    } catch (error) {
        console.error('Error generating email:', error);
        ctx.reply('❌ Error generating email. Please try again.', { reply_markup: keyboard });
    } finally {
        await connection.end();
    }
});

// Handle "📥 Inbox" button
bot.hears('📥 Inbox', async (ctx) => {
    const userId = ctx.from.id;
    const connection = await createConnection();
    
    try {
        // Get latest email for user
        const [rows] = await connection.execute(
            'SELECT * FROM emails WHERE user_id = ? ORDER BY last_access DESC LIMIT 1',
            [userId]
        );
        
        if (rows.length === 0) {
            ctx.reply('❌ No email found. Please generate a new one first.', 
                { reply_markup: keyboard });
            return;
        }
        
        let email = rows[0];
        let token = email.token;
        
        try {
            // Try to get messages with current token
            const messages = await mailAPI.getMessages(token);
            
            if (messages.length === 0) {
                ctx.reply('📭 Your inbox is empty. No new messages.', 
                    { reply_markup: keyboard });
                return;
            }
            
            // Get the latest message details
            const latestMessage = messages[0];
            const messageDetails = await mailAPI.getMessage(latestMessage.id, token);
            
            // Update last access
            await connection.execute(
                'UPDATE emails SET last_access = NOW() WHERE id = ?',
                [email.id]
            );
            
            const inboxMessage = `📩 New Mail Received In Your Email ID 🪧

📇 From : ${messageDetails.from.address}

🗒️ Subject : ${messageDetails.subject}

💬 Text : ${messageDetails.text || messageDetails.intro || 'No text content'}`;
            
            ctx.reply(inboxMessage, { reply_markup: keyboard });
            
            // Broadcast update via WebSocket
            if (global.broadcastInboxUpdate) {
                global.broadcastInboxUpdate(userId, messageDetails);
            }
            
        } catch (apiError) {
            // Token might be expired, try to refresh
            try {
                token = await mailAPI.getToken(email.email, email.password);
                
                // Update token in database
                await connection.execute(
                    'UPDATE emails SET token = ? WHERE id = ?',
                    [token, email.id]
                );
                
                // Retry getting messages
                const messages = await mailAPI.getMessages(token);
                
                if (messages.length === 0) {
                    ctx.reply('📭 Your inbox is empty. No new messages.', 
                        { reply_markup: keyboard });
                    return;
                }
                
                const latestMessage = messages[0];
                const messageDetails = await mailAPI.getMessage(latestMessage.id, token);
                
                const inboxMessage = `📩 New Mail Received In Your Email ID 🪧

📇 From : ${messageDetails.from.address}

🗒️ Subject : ${messageDetails.subject}

💬 Text : ${messageDetails.text || messageDetails.intro || 'No text content'}`;
                
                ctx.reply(inboxMessage, { reply_markup: keyboard });
                
            } catch (refreshError) {
                console.error('Error refreshing token:', refreshError);
                ctx.reply('❌ Error accessing inbox. Please try again.', 
                    { reply_markup: keyboard });
            }
        }
        
    } catch (error) {
        console.error('Error fetching inbox:', error);
        ctx.reply('❌ Error fetching inbox. Please try again.', { reply_markup: keyboard });
    } finally {
        await connection.end();
    }
});

// Handle "♻️ Recovery" button
bot.hears('♻️ Recovery', (ctx) => {
    ctx.reply('✉️ Please enter your recovery email:', { reply_markup: { force_reply: true } });
    userSessions.set(ctx.from.id + '_recovery', true);
});

// Handle recovery email input
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const isRecovery = userSessions.get(userId + '_recovery');
    
    if (isRecovery && !ctx.message.text.startsWith('/') && 
        !['📧 My Email', '🔄 Generate New', '📥 Inbox', '♻️ Recovery'].includes(ctx.message.text)) {
        
        const recoveryEmail = ctx.message.text.trim();
        const connection = await createConnection();
        
        try {
            const [rows] = await connection.execute(
                'SELECT * FROM emails WHERE user_id = ? AND email = ?',
                [userId, recoveryEmail]
            );
            
            if (rows.length > 0) {
                const email = rows[0];
                
                // Refresh token
                try {
                    const newToken = await mailAPI.getToken(email.email, email.password);
                    
                    await connection.execute(
                        'UPDATE emails SET token = ?, last_access = NOW() WHERE id = ?',
                        [newToken, email.id]
                    );
                    
                    userSessions.set(userId, { 
                        email: email.email, 
                        password: email.password, 
                        token: newToken 
                    });
                    
                    const message = `♻️ Recovery Email Successfully ✅

📬 Recovery Email ID : ${email.email} 👈`;
                    
                    ctx.reply(message, { reply_markup: keyboard });
                    
                } catch (tokenError) {
                    console.error('Error refreshing recovery token:', tokenError);
                    ctx.reply('❌ Email found but unable to recover. Please generate a new one.', 
                        { reply_markup: keyboard });
                }
            } else {
                ctx.reply('❌ Email not found in your history. Please check the email address.', 
                    { reply_markup: keyboard });
            }
        } catch (error) {
            console.error('Error during recovery:', error);
            ctx.reply('❌ Error during recovery. Please try again.', { reply_markup: keyboard });
        } finally {
            await connection.end();
            userSessions.delete(userId + '_recovery');
        }
    }
});

// Error handling
bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply('❌ An error occurred. Please try again.', { reply_markup: keyboard });
});

// Initialize database and launch bot
async function startBot() {
    try {
        await initDatabase();
        await bot.launch();
        console.log('Bot started successfully');
    } catch (error) {
        console.error('Error starting bot:', error);
        process.exit(1);
    }
}

startBot();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;
