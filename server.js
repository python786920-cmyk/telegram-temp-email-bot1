require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bot = require('./bot');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());

// Database connection pool
const dbPool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true
});

// Initialize database
async function initDatabase() {
  try {
    const connection = await dbPool.getConnection();
    
    // Create emails table if not exists
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS emails (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL,
        token VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_access DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_email (email)
      )
    `;
    
    await connection.execute(createTableQuery);
    console.log('Database initialized successfully');
    connection.release();
  } catch (error) {
    console.error('Database initialization error:', error);
    process.exit(1);
  }
}

// WebSocket connection handling
const connectedClients = new Map();

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'register' && data.userId) {
        connectedClients.set(data.userId, ws);
        console.log(`User ${data.userId} registered for WebSocket updates`);
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
  
  ws.on('close', () => {
    // Remove client from connected clients
    for (const [userId, client] of connectedClients.entries()) {
      if (client === ws) {
        connectedClients.delete(userId);
        console.log(`User ${userId} disconnected from WebSocket`);
        break;
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Function to broadcast inbox updates
function broadcastInboxUpdate(userId, inboxData) {
  const client = connectedClients.get(userId.toString());
  if (client && client.readyState === client.CONSTRUCTOR.OPEN) {
    try {
      client.send(JSON.stringify({
        type: 'inbox_update',
        data: inboxData
      }));
    } catch (error) {
      console.error('Error broadcasting inbox update:', error);
    }
  }
}

// Export database and broadcast function for bot usage
global.dbPool = dbPool;
global.broadcastInboxUpdate = broadcastInboxUpdate;

// Basic health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Telegram Temp Email Bot is running' });
});

// Inbox polling endpoint (for additional real-time support)
app.get('/inbox/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get user's active email session
    const [rows] = await dbPool.execute(
      'SELECT * FROM emails WHERE user_id = ? ORDER BY last_access DESC LIMIT 1',
      [userId]
    );
    
    if (rows.length === 0) {
      return res.json({ error: 'No active email session found' });
    }
    
    const emailData = rows[0];
    
    // Fetch inbox data using the bot's email service
    const axios = require('axios');
    
    try {
      const response = await axios.get(`${process.env.MAIL_TM_API_URL}/messages`, {
        headers: {
          'Authorization': `Bearer ${emailData.token}`
        }
      });
      
      res.json({ success: true, messages: response.data });
    } catch (apiError) {
      console.error('Mail API error:', apiError);
      res.json({ error: 'Failed to fetch inbox data' });
    }
    
  } catch (error) {
    console.error('Inbox endpoint error:', error);
    res.json({ error: 'Internal server error' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Initialize database first
    await initDatabase();
    
    // Start the bot
    console.log('Starting Telegram bot...');
    await bot.launch();
    
    // Start HTTP server with WebSocket
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`WebSocket server running on the same port`);
      console.log('Telegram Temp Email Bot is fully operational! 🚀');
    });
    
    // Enable graceful stop
    process.once('SIGINT', () => {
      console.log('Received SIGINT, shutting down gracefully...');
      bot.stop('SIGINT');
      server.close(() => {
        console.log('Server closed');
        dbPool.end();
        process.exit(0);
      });
    });
    
    process.once('SIGTERM', () => {
      console.log('Received SIGTERM, shutting down gracefully...');
      bot.stop('SIGTERM');
      server.close(() => {
        console.log('Server closed');
        dbPool.end();
        process.exit(0);
      });
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
