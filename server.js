const express = require('express');
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();

const bot = require('./bot');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Basic route
app.get('/', (req, res) => {
    res.send('Telegram Temp Email Bot is running!');
});

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');
    
    ws.on('message', (message) => {
        console.log('Received WebSocket message:', message.toString());
    });
    
    ws.on('close', () => {
        console.log('WebSocket connection closed');
    });
});

// Function to broadcast inbox updates
function broadcastInboxUpdate(userId, emailData) {
    const message = JSON.stringify({
        type: 'inbox_update',
        userId: userId,
        data: emailData
    });
    
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Export broadcast function for use in bot
global.broadcastInboxUpdate = broadcastInboxUpdate;

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Telegram bot started...');
});
