const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// User sessions for recovery process
const userSessions = new Map();

// Keyboard layout - exactly as specified
const mainKeyboard = Markup.keyboard([
  ['📧 My Email'],
  ['🔄 Generate New', '📥 Inbox'],
  ['♻️ Recovery']
]).resize().persistent();

// Email service functions
class EmailService {
  static async getDomains() {
    try {
      const response = await axios.get(`${process.env.MAIL_TM_API_URL}/domains`);
      return response.data['hydra:member'] || [];
    } catch (error) {
      console.error('Error fetching domains:', error);
      return [];
    }
  }

  static async createAccount(email, password) {
    try {
      const response = await axios.post(`${process.env.MAIL_TM_API_URL}/accounts`, {
        address: email,
        password: password
      });
      return response.data;
    } catch (error) {
      console.error('Error creating account:', error);
      return null;
    }
  }

  static async getToken(email, password) {
    try {
      const response = await axios.post(`${process.env.MAIL_TM_API_URL}/token`, {
        address: email,
        password: password
      });
      return response.data.token;
    } catch (error) {
      console.error('Error getting token:', error);
      return null;
    }
  }

  static async getMessages(token) {
    try {
      const response = await axios.get(`${process.env.MAIL_TM_API_URL}/messages`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      return response.data['hydra:member'] || [];
    } catch (error) {
      console.error('Error fetching messages:', error);
      return [];
    }
  }

  static async getMessage(token, messageId) {
    try {
      const response = await axios.get(`${process.env.MAIL_TM_API_URL}/messages/${messageId}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching message:', error);
      return null;
    }
  }

  static async refreshToken(email, password) {
    try {
      const newToken = await this.getToken(email, password);
      if (newToken) {
        // Update token in database
        await global.dbPool.execute(
          'UPDATE emails SET token = ?, last_access = NOW() WHERE email = ?',
          [newToken, email]
        );
        return newToken;
      }
      return null;
    } catch (error) {
      console.error('Error refreshing token:', error);
      return null;
    }
  }
}

// Database functions
async function saveEmailToDb(userId, email, password, token) {
  try {
    await global.dbPool.execute(
      'INSERT INTO emails (user_id, email, password, token) VALUES (?, ?, ?, ?)',
      [userId, email, password, token]
    );
    return true;
  } catch (error) {
    console.error('Error saving email to database:', error);
    return false;
  }
}

async function getUserEmails(userId) {
  try {
    const [rows] = await global.dbPool.execute(
      'SELECT * FROM emails WHERE user_id = ? ORDER BY last_access DESC',
      [userId]
    );
    return rows;
  } catch (error) {
    console.error('Error fetching user emails:', error);
    return [];
  }
}

async function getEmailByAddress(email) {
  try {
    const [rows] = await global.dbPool.execute(
      'SELECT * FROM emails WHERE email = ? LIMIT 1',
      [email]
    );
    return rows[0] || null;
  } catch (error) {
    console.error('Error fetching email by address:', error);
    return null;
  }
}

async function updateLastAccess(email) {
  try {
    await global.dbPool.execute(
      'UPDATE emails SET last_access = NOW() WHERE email = ?',
      [email]
    );
  } catch (error) {
    console.error('Error updating last access:', error);
  }
}

// Bot command handlers
bot.start((ctx) => {
  const message = `😜 Hey Anish Welcome To OUR BoT

🧑‍💻 BoT Created BY : @earning_tips009`;
  
  ctx.reply(message, mainKeyboard);
});

// Generate New Email
bot.hears('🔄 Generate New', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    
    // Get available domains
    const domains = await EmailService.getDomains();
    if (domains.length === 0) {
      return ctx.reply('❌ No domains available. Please try again later.');
    }
    
    // Generate random email and password
    const randomString = Math.random().toString(36).substring(2, 10);
    const domain = domains[0].domain;
    const email = `${randomString}@${domain}`;
    const password = Math.random().toString(36).substring(2, 12);
    
    // Create account
    const account = await EmailService.createAccount(email, password);
    if (!account) {
      return ctx.reply('❌ Failed to create email account. Please try again.');
    }
    
    // Get token
    const token = await EmailService.getToken(email, password);
    if (!token) {
      return ctx.reply('❌ Failed to get access token. Please try again.');
    }
    
    // Save to database
    const saved = await saveEmailToDb(userId, email, password, token);
    if (!saved) {
      return ctx.reply('❌ Failed to save email. Please try again.');
    }
    
    // Success message - exactly as specified
    const successMessage = `♻️ New Email Generated Successfully ✅

📬 Email ID : ${email} 👈`;
    
    ctx.reply(successMessage, mainKeyboard);
    
  } catch (error) {
    console.error('Error generating new email:', error);
    ctx.reply('❌ An error occurred. Please try again.');
  }
});

// My Email
bot.hears('📧 My Email', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const userEmails = await getUserEmails(userId);
    
    if (userEmails.length === 0) {
      return ctx.reply('❌ No email found. Please generate a new email first.', mainKeyboard);
    }
    
    const latestEmail = userEmails[0];
    const message = `📧 Your Active Email:

📬 Email ID : ${latestEmail.email} 👈
🕒 Created : ${new Date(latestEmail.created_at).toLocaleString()}
🔄 Last Access : ${new Date(latestEmail.last_access).toLocaleString()}`;
    
    ctx.reply(message, mainKeyboard);
    
  } catch (error) {
    console.error('Error fetching user email:', error);
    ctx.reply('❌ An error occurred. Please try again.');
  }
});

// Inbox
bot.hears('📥 Inbox', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const userEmails = await getUserEmails(userId);
    
    if (userEmails.length === 0) {
      return ctx.reply('❌ No email found. Please generate a new email first.', mainKeyboard);
    }
    
    const emailData = userEmails[0];
    let token = emailData.token;
    
    // Try to get messages
    let messages = await EmailService.getMessages(token);
    
    // If token expired, refresh it
    if (messages.length === 0 || messages.error) {
      token = await EmailService.refreshToken(emailData.email, emailData.password);
      if (token) {
        messages = await EmailService.getMessages(token);
      } else {
        return ctx.reply('❌ Failed to refresh access token. Please try again.', mainKeyboard);
      }
    }
    
    await updateLastAccess(emailData.email);
    
    if (messages.length === 0) {
      return ctx.reply('📭 No messages found in your inbox.', mainKeyboard);
    }
    
    // Get the latest message details
    const latestMessage = messages[0];
    const messageDetails = await EmailService.getMessage(token, latestMessage.id);
    
    if (!messageDetails) {
      return ctx.reply('❌ Failed to fetch message details.', mainKeyboard);
    }
    
    // Format message exactly as specified
    const inboxMessage = `📩 New Mail Received In Your Email ID 🪧

📇 From : ${messageDetails.from.address}

🗒️ Subject : ${messageDetails.subject}

💬 Text : ${messageDetails.text || messageDetails.html || 'No content available'}`;
    
    ctx.reply(inboxMessage, mainKeyboard);
    
    // Broadcast real-time update via WebSocket
    if (global.broadcastInboxUpdate) {
      global.broadcastInboxUpdate(userId, {
        email: emailData.email,
        message: messageDetails,
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('Error fetching inbox:', error);
    ctx.reply('❌ An error occurred while fetching inbox. Please try again.');
  }
});

// Recovery
bot.hears('♻️ Recovery', async (ctx) => {
  const userId = ctx.from.id.toString();
  userSessions.set(userId, { state: 'awaiting_recovery_email' });
  
  ctx.reply('✉️ Please enter your recovery email:', {
    reply_markup: {
      force_reply: true
    }
  });
});

// Handle text messages (for recovery and other inputs)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = userSessions.get(userId);
  
  if (session && session.state === 'awaiting_recovery_email') {
    const recoveryEmail = ctx.message.text.trim();
    
    try {
      // Check if email exists in database
      const emailData = await getEmailByAddress(recoveryEmail);
      
      if (!emailData) {
        userSessions.delete(userId);
        return ctx.reply('❌ Email not found in our records. Please check and try again.', mainKeyboard);
      }
      
      // Refresh token
      const newToken = await EmailService.refreshToken(emailData.email, emailData.password);
      
      if (!newToken) {
        userSessions.delete(userId);
        return ctx.reply('❌ Failed to recover email access. Please try again.', mainKeyboard);
      }
      
      // Update last access
      await updateLastAccess(emailData.email);
      
      // Success message - exactly as specified
      const recoveryMessage = `♻️ Recovery Email Successfully ✅

📬 Recovery Email ID : ${emailData.email} 👈`;
      
      ctx.reply(recoveryMessage, mainKeyboard);
      
      // Clear session
      userSessions.delete(userId);
      
    } catch (error) {
      console.error('Error during email recovery:', error);
      userSessions.delete(userId);
      ctx.reply('❌ An error occurred during recovery. Please try again.');
    }
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ An unexpected error occurred. Please try again.');
});

// Periodic inbox checking for real-time updates
setInterval(async () => {
  try {
    // Get all recent active emails (accessed in last 30 minutes)
    const [activeEmails] = await global.dbPool.execute(`
      SELECT DISTINCT user_id, email, password, token 
      FROM emails 
      WHERE last_access > DATE_SUB(NOW(), INTERVAL 30 MINUTE)
      ORDER BY last_access DESC
    `);
    
    for (const emailData of activeEmails) {
      try {
        let token = emailData.token;
        let messages = await EmailService.getMessages(token);
        
        // If token expired, refresh it
        if (messages.error) {
          token = await EmailService.refreshToken(emailData.email, emailData.password);
          if (token) {
            messages = await EmailService.getMessages(token);
          }
        }
        
        if (messages && messages.length > 0 && global.broadcastInboxUpdate) {
          global.broadcastInboxUpdate(emailData.user_id, {
            email: emailData.email,
            messageCount: messages.length,
            latestMessage: messages[0],
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        console.error(`Error checking inbox for ${emailData.email}:`, error);
      }
    }
  } catch (error) {
    console.error('Error in periodic inbox check:', error);
  }
}, 30000); // Check every 30 seconds

module.exports = bot;
