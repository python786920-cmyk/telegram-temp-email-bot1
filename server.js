const express = require('express');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Database connection pool
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

// WebSocket server for real-time updates
const wss = new WebSocket.Server({ port: WS_PORT });

// Store active WebSocket connections
const activeConnections = new Map();

wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register' && data.userId) {
                activeConnections.set(data.userId, ws);
                console.log(`User ${data.userId} registered for WebSocket updates`);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    ws.on('close', () => {
        // Remove connection from active connections
        for (const [userId, connection] of activeConnections.entries()) {
            if (connection === ws) {
                activeConnections.delete(userId);
                console.log(`User ${userId} WebSocket connection closed`);
                break;
            }
        }
    });
});

// Helper function to update last_access timestamp
async function updateLastAccess(email) {
    try {
        const connection = await pool.getConnection();
        await connection.execute("UPDATE emails SET last_access = NOW() WHERE email = ?", [email]);
        connection.release();
    } catch (error) {
        console.error('Error updating last access:', error);
    }
}

// Helper function to broadcast updates to WebSocket clients
function broadcastUpdate(userId, data) {
    if (activeConnections.has(userId)) {
        const ws = activeConnections.get(userId);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }
}

// Email service functions
class EmailService {
    static async generateEmail() {
        try {
            // Get available domains
            const axios = require('axios');
            const domainResponse = await axios.get('https://api.mail.tm/domains');
            const domains = domainResponse.data['hydra:member'].map(d => d.domain);
            const domain = domains[Math.floor(Math.random() * domains.length)];

            // Generate username
            const prefixes = ['temp', 'quick', 'fast', 'instant', 'rapid', 'swift', 'flash'];
            const username = prefixes[Math.floor(Math.random() * prefixes.length)] + 
                           Math.floor(100000 + Math.random() * 900000);
            const email = `${username}@${domain}`;
            const password = `TempMail${Math.floor(100 + Math.random() * 900)}!`;

            // Create account
            const createResponse = await axios.post('https://api.mail.tm/accounts', {
                address: email,
                password: password
            }, {
                headers: { 'Content-Type': 'application/json' }
            });

            if (createResponse.status !== 201) {
                throw new Error('Failed to create account');
            }

            // Get token
            const tokenResponse = await axios.post('https://api.mail.tm/token', {
                address: email,
                password: password
            }, {
                headers: { 'Content-Type': 'application/json' }
            });

            if (!tokenResponse.data.token) {
                throw new Error('Failed to get token');
            }

            // Save to database
            const connection = await pool.getConnection();
            await connection.execute(
                "INSERT INTO emails (email, password, token, created_at, last_access) VALUES (?, ?, ?, NOW(), NOW())",
                [email, password, tokenResponse.data.token]
            );
            connection.release();

            return {
                email,
                password,
                token: tokenResponse.data.token,
                domains
            };
        } catch (error) {
            console.error('Generate email error:', error);
            throw new Error('Failed to generate email');
        }
    }

    static async getInbox(token, email) {
        try {
            const axios = require('axios');
            let currentToken = token;

            // Try to fetch messages
            let response;
            try {
                response = await axios.get('https://api.mail.tm/messages', {
                    headers: { 'Authorization': `Bearer ${currentToken}` }
                });
            } catch (error) {
                if (error.response && error.response.status === 401) {
                    // Token expired, refresh it
                    const connection = await pool.getConnection();
                    const [rows] = await connection.execute("SELECT password FROM emails WHERE email = ?", [email]);
                    connection.release();

                    if (rows.length === 0) {
                        throw new Error('Email not found in database');
                    }

                    // Refresh token
                    const tokenResponse = await axios.post('https://api.mail.tm/token', {
                        address: email,
                        password: rows[0].password
                    }, {
                        headers: { 'Content-Type': 'application/json' }
                    });

                    if (!tokenResponse.data.token) {
                        throw new Error('Failed to refresh token');
                    }

                    currentToken = tokenResponse.data.token;

                    // Update token in database
                    const updateConnection = await pool.getConnection();
                    await updateConnection.execute(
                        "UPDATE emails SET token = ?, last_access = NOW() WHERE email = ?",
                        [currentToken, email]
                    );
                    updateConnection.release();

                    // Retry with new token
                    response = await axios.get('https://api.mail.tm/messages', {
                        headers: { 'Authorization': `Bearer ${currentToken}` }
                    });
                } else {
                    throw error;
                }
            }

            const messages = (response.data['hydra:member'] || []).map(msg => ({
                from: msg.from.address,
                subject: msg.subject,
                id: msg.id,
                createdAt: msg.createdAt,
                hasAttachments: msg.attachments && msg.attachments.length > 0,
                seen: msg.seen
            }));

            await updateLastAccess(email);
            return { messages, token: currentToken };
        } catch (error) {
            console.error('Get inbox error:', error);
            throw new Error('Failed to fetch inbox');
        }
    }

    static async readMessage(token, id, email) {
        try {
            const axios = require('axios');
            const response = await axios.get(`https://api.mail.tm/messages/${id}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            await updateLastAccess(email);
            return response.data;
        } catch (error) {
            console.error('Read message error:', error);
            throw new Error('Failed to read message');
        }
    }

    static async deleteMessage(token, id, email) {
        try {
            const axios = require('axios');
            await axios.delete(`https://api.mail.tm/messages/${id}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            await updateLastAccess(email);
            return { success: true };
        } catch (error) {
            console.error('Delete message error:', error);
            throw new Error('Failed to delete message');
        }
    }

    static async recoverEmail(email) {
        try {
            const connection = await pool.getConnection();
            const [rows] = await connection.execute(
                "SELECT email, password, token, created_at FROM emails WHERE email = ?",
                [email]
            );
            connection.release();

            if (rows.length === 0) {
                throw new Error('Email not found in database');
            }

            const emailData = rows[0];

            // Try to refresh token
            const axios = require('axios');
            const tokenResponse = await axios.post('https://api.mail.tm/token', {
                address: emailData.email,
                password: emailData.password
            }, {
                headers: { 'Content-Type': 'application/json' }
            });

            if (!tokenResponse.data.token) {
                throw new Error('Failed to refresh token');
            }

            // Update token in database
            const updateConnection = await pool.getConnection();
            await updateConnection.execute(
                "UPDATE emails SET token = ?, last_access = NOW() WHERE email = ?",
                [tokenResponse.data.token, emailData.email]
            );
            updateConnection.release();

            return {
                email: emailData.email,
                token: tokenResponse.data.token
            };
        } catch (error) {
            console.error('Recover email error:', error);
            throw new Error('Failed to recover email');
        }
    }
}

// API Routes
app.get('/api/generate', async (req, res) => {
    try {
        const result = await EmailService.generateEmail();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/inbox', async (req, res) => {
    try {
        const { token, email } = req.query;
        if (!token || !email) {
            return res.status(400).json({ error: 'Token and email required' });
        }

        const result = await EmailService.getInbox(token, email);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/read', async (req, res) => {
    try {
        const { token, id, email } = req.query;
        const result = await EmailService.readMessage(token, id, email);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/delete', async (req, res) => {
    try {
        const { token, id, email } = req.query;
        const result = await EmailService.deleteMessage(token, id, email);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/recover', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email address required' });
        }

        const result = await EmailService.recoverEmail(email);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔌 WebSocket server running on port ${WS_PORT}`);
    console.log(`🤖 Ready for Telegram Bot integration`);
});

// Export for bot integration
module.exports = { app, EmailService, broadcastUpdate, activeConnections };
