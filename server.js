const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const axios = require('axios');
const { createServer } = require('http');
require('dotenv').config();

class TempEmailServer {
    constructor() {
        this.app = express();
        this.server = createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        this.dbPool = null;
        this.clients = new Map();
        this.activeEmails = new Map();
        this.init();
    }

    async init() {
        await this.setupDatabase();
        this.setupMiddleware();
        this.setupWebSocket();
        this.setupRoutes();
        this.startServer();
        this.startAutoRefresh();
    }

    async setupDatabase() {
        this.dbPool = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
            queueLimit: 0,
            acquireTimeout: parseInt(process.env.DB_ACQUIRE_TIMEOUT) || 60000,
            timeout: parseInt(process.env.DB_TIMEOUT) || 60000
        });

        // Create table if not exists
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS emails (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                token TEXT NOT NULL,
                telegram_user_id BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_access TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_email (email),
                INDEX idx_telegram_user_id (telegram_user_id),
                INDEX idx_last_access (last_access)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `;

        try {
            await this.dbPool.execute(createTableQuery);
            console.log('📊 Database table initialized successfully');
        } catch (error) {
            console.error('❌ Database initialization error:', error);
            process.exit(1);
        }
    }

    setupMiddleware() {
        this.app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
                    scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
                    imgSrc: ["'self'", "data:", "https:"],
                    connectSrc: ["'self'", "ws:", "wss:"],
                    fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
                }
            }
        }));
        
        this.app.use(compression());
        this.app.use(cors({
            origin: process.env.CORS_ORIGIN || '*',
            methods: ['GET', 'POST', 'PUT', 'DELETE'],
            allowedHeaders: ['Content-Type', 'Authorization']
        }));
        
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
        
        // Rate limiting middleware
        this.app.use((req, res, next) => {
            const clientIP = req.ip || req.connection.remoteAddress;
            const now = Date.now();
            
            if (!this.rateLimitMap) this.rateLimitMap = new Map();
            
            const clientData = this.rateLimitMap.get(clientIP) || { requests: 0, resetTime: now + 60000 };
            
            if (now > clientData.resetTime) {
                clientData.requests = 0;
                clientData.resetTime = now + 60000;
            }
            
            if (clientData.requests >= (process.env.RATE_LIMIT || 100)) {
                return res.status(429).json({ error: 'Rate limit exceeded' });
            }
            
            clientData.requests++;
            this.rateLimitMap.set(clientIP, clientData);
            next();
        });
    }

    setupWebSocket() {
        this.wss.on('connection', (ws, req) => {
            const clientId = this.generateId();
            this.clients.set(clientId, ws);
            
            console.log(`🔗 WebSocket client connected: ${clientId}`);
            
            ws.on('message', async (message) => {
                try {
                    const data = JSON.parse(message);
                    await this.handleWebSocketMessage(ws, data, clientId);
                } catch (error) {
                    ws.send(JSON.stringify({ error: 'Invalid message format' }));
                }
            });
            
            ws.on('close', () => {
                this.clients.delete(clientId);
                console.log(`🔌 WebSocket client disconnected: ${clientId}`);
            });
            
            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.clients.delete(clientId);
            });
        });
    }

    async handleWebSocketMessage(ws, data, clientId) {
        const { action, email, token, telegramUserId } = data;
        
        switch (action) {
            case 'subscribe':
                if (email && token) {
                    this.activeEmails.set(email, { ws, clientId, token, telegramUserId });
                    ws.send(JSON.stringify({ 
                        action: 'subscribed', 
                        email,
                        message: 'Successfully subscribed to email updates'
                    }));
                }
                break;
                
            case 'unsubscribe':
                if (email) {
                    this.activeEmails.delete(email);
                    ws.send(JSON.stringify({ 
                        action: 'unsubscribed', 
                        email,
                        message: 'Successfully unsubscribed from email updates'
                    }));
                }
                break;
                
            case 'ping':
                ws.send(JSON.stringify({ action: 'pong', timestamp: Date.now() }));
                break;
        }
    }

    setupRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy', 
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                activeConnections: this.clients.size,
                activeEmails: this.activeEmails.size
            });
        });

        // Generate new email
        this.app.post('/api/generate', async (req, res) => {
            try {
                const { telegramUserId } = req.body;
                const result = await this.generateEmail(telegramUserId);
                res.json(result);
            } catch (error) {
                console.error('Generate email error:', error);
                res.status(500).json({ error: 'Failed to generate email' });
            }
        });

        // Get inbox messages
        this.app.get('/api/inbox/:email', async (req, res) => {
            try {
                const { email } = req.params;
                const { token } = req.query;
                const messages = await this.getInboxMessages(email, token);
                res.json(messages);
            } catch (error) {
                console.error('Get inbox error:', error);
                res.status(500).json({ error: 'Failed to fetch inbox' });
            }
        });

        // Read specific message
        this.app.get('/api/message/:email/:messageId', async (req, res) => {
            try {
                const { email, messageId } = req.params;
                const { token } = req.query;
                const message = await this.readMessage(messageId, token);
                await this.updateLastAccess(email);
                res.json(message);
            } catch (error) {
                console.error('Read message error:', error);
                res.status(500).json({ error: 'Failed to read message' });
            }
        });

        // Delete message
        this.app.delete('/api/message/:email/:messageId', async (req, res) => {
            try {
                const { email, messageId } = req.params;
                const { token } = req.query;
                await this.deleteMessage(messageId, token);
                await this.updateLastAccess(email);
                res.json({ success: true });
            } catch (error) {
                console.error('Delete message error:', error);
                res.status(500).json({ error: 'Failed to delete message' });
            }
        });

        // Recover email
        this.app.post('/api/recover', async (req, res) => {
            try {
                const { email, telegramUserId } = req.body;
                const result = await this.recoverEmail(email, telegramUserId);
                res.json(result);
            } catch (error) {
                console.error('Recover email error:', error);
                res.status(500).json({ error: 'Failed to recover email' });
            }
        });

        // Get user emails
        this.app.get('/api/user/:telegramUserId/emails', async (req, res) => {
            try {
                const { telegramUserId } = req.params;
                const emails = await this.getUserEmails(telegramUserId);
                res.json(emails);
            } catch (error) {
                console.error('Get user emails error:', error);
                res.status(500).json({ error: 'Failed to fetch user emails' });
            }
        });

        // Webhook endpoint for bot
        this.app.post('/webhook', (req, res) => {
            // This will be handled by the bot instance
            res.sendStatus(200);
        });

        // Default route
        this.app.get('/', (req, res) => {
            res.json({
                name: 'Professional Temp Email API',
                version: '1.0.0',
                status: 'running',
                endpoints: {
                    generate: 'POST /api/generate',
                    inbox: 'GET /api/inbox/:email',
                    message: 'GET /api/message/:email/:messageId',
                    delete: 'DELETE /api/message/:email/:messageId',
                    recover: 'POST /api/recover',
                    userEmails: 'GET /api/user/:telegramUserId/emails',
                    health: 'GET /health'
                }
            });
        });
    }

    async generateEmail(telegramUserId = null) {
        try {
            // Get available domains
            const domainsResponse = await axios.get(`${process.env.MAIL_TM_BASE_URL}/domains`);
            const domains = domainsResponse.data['hydra:member'].map(d => d.domain);
            const domain = domains[Math.floor(Math.random() * domains.length)];

            // Generate unique username
            const prefixes = ['temp', 'quick', 'fast', 'instant', 'rapid', 'swift', 'flash'];
            const username = prefixes[Math.floor(Math.random() * prefixes.length)] + 
                           Math.floor(Math.random() * 900000 + 100000);
            const email = `${username}@${domain}`;
            const password = `TempMail${Math.floor(Math.random() * 900 + 100)}!`;

            // Create account on mail.tm
            const createResponse = await axios.post(`${process.env.MAIL_TM_BASE_URL}/accounts`, {
                address: email,
                password: password
            });

            if (createResponse.status !== 201) {
                throw new Error('Failed to create email account');
            }

            // Get authentication token
            const tokenResponse = await axios.post(`${process.env.MAIL_TM_BASE_URL}/token`, {
                address: email,
                password: password
            });

            const token = tokenResponse.data.token;

            // Save to database
            const query = `
                INSERT INTO emails (email, password, token, telegram_user_id, created_at, last_access) 
                VALUES (?, ?, ?, ?, NOW(), NOW())
            `;
            
            await this.dbPool.execute(query, [email, password, token, telegramUserId]);

            return {
                email,
                password,
                token,
                domains,
                created: new Date().toISOString()
            };

        } catch (error) {
            console.error('Generate email error:', error);
            throw error;
        }
    }

    async getInboxMessages(email, token) {
        try {
            // First try with current token
            let response;
            try {
                response = await axios.get(`${process.env.MAIL_TM_BASE_URL}/messages`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
            } catch (error) {
                if (error.response?.status === 401) {
                    // Token expired, refresh it
                    const newToken = await this.refreshToken(email);
                    response = await axios.get(`${process.env.MAIL_TM_BASE_URL}/messages`, {
                        headers: { Authorization: `Bearer ${newToken}` }
                    });
                    token = newToken;
                } else {
                    throw error;
                }
            }

            const messages = response.data['hydra:member'] || [];
            await this.updateLastAccess(email);

            return messages.map(msg => ({
                id: msg.id,
                from: msg.from.address,
                subject: msg.subject || 'No Subject',
                createdAt: msg.createdAt,
                hasAttachments: !!(msg.attachments && msg.attachments.length > 0),
                seen: msg.seen,
                intro: msg.intro || ''
            }));

        } catch (error) {
            console.error('Get inbox messages error:', error);
            throw error;
        }
    }

    async readMessage(messageId, token) {
        try {
            const response = await axios.get(`${process.env.MAIL_TM_BASE_URL}/messages/${messageId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            return response.data;
        } catch (error) {
            console.error('Read message error:', error);
            throw error;
        }
    }

    async deleteMessage(messageId, token) {
        try {
            await axios.delete(`${process.env.MAIL_TM_BASE_URL}/messages/${messageId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        } catch (error) {
            console.error('Delete message error:', error);
            throw error;
        }
    }

    async refreshToken(email) {
        try {
            const query = 'SELECT password FROM emails WHERE email = ?';
            const [rows] = await this.dbPool.execute(query, [email]);
            
            if (rows.length === 0) {
                throw new Error('Email not found');
            }

            const tokenResponse = await axios.post(`${process.env.MAIL_TM_BASE_URL}/token`, {
                address: email,
                password: rows[0].password
            });

            const newToken = tokenResponse.data.token;

            // Update token in database
            const updateQuery = 'UPDATE emails SET token = ?, last_access = NOW() WHERE email = ?';
            await this.dbPool.execute(updateQuery, [newToken, email]);

            return newToken;
        } catch (error) {
            console.error('Refresh token error:', error);
            throw error;
        }
    }

    async recoverEmail(email, telegramUserId = null) {
        try {
            const query = 'SELECT email, password, token, created_at FROM emails WHERE email = ?';
            const [rows] = await this.dbPool.execute(query, [email]);
            
            if (rows.length === 0) {
                throw new Error('Email not found in database');
            }

            const emailData = rows[0];

            // Try to refresh token
            const newToken = await this.refreshToken(email);

            // Update telegram_user_id if provided
            if (telegramUserId) {
                const updateQuery = 'UPDATE emails SET telegram_user_id = ?, last_access = NOW() WHERE email = ?';
                await this.dbPool.execute(updateQuery, [telegramUserId, email]);
            }

            return {
                email: emailData.email,
                token: newToken,
                created: emailData.created_at
            };

        } catch (error) {
            console.error('Recover email error:', error);
            throw error;
        }
    }

    async getUserEmails(telegramUserId) {
        try {
            const query = `
                SELECT email, created_at, last_access 
                FROM emails 
                WHERE telegram_user_id = ? 
                ORDER BY last_access DESC
            `;
            const [rows] = await this.dbPool.execute(query, [telegramUserId]);
            
            return rows;
        } catch (error) {
            console.error('Get user emails error:', error);
            throw error;
        }
    }

    async updateLastAccess(email) {
        try {
            const query = 'UPDATE emails SET last_access = NOW() WHERE email = ?';
            await this.dbPool.execute(query, [email]);
        } catch (error) {
            console.error('Update last access error:', error);
        }
    }

    // Auto-refresh functionality for WebSocket clients
    startAutoRefresh() {
        setInterval(async () => {
            for (const [email, client] of this.activeEmails.entries()) {
                try {
                    const messages = await this.getInboxMessages(email, client.token);
                    
                    if (client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(JSON.stringify({
                            action: 'inbox_update',
                            email,
                            messages,
                            timestamp: Date.now()
                        }));
                    } else {
                        this.activeEmails.delete(email);
                    }
                } catch (error) {
                    console.error(`Auto-refresh error for ${email}:`, error);
                    if (client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(JSON.stringify({
                            action: 'error',
                            email,
                            error: 'Failed to refresh inbox'
                        }));
                    }
                }
            }
        }, parseInt(process.env.AUTO_REFRESH_INTERVAL) || 10000);
    }

    generateId() {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

    startServer() {
        const port = process.env.PORT || 3000;
        this.server.listen(port, () => {
            console.log('🚀 Professional Temp Email Server Started');
            console.log(`📡 HTTP Server: http://localhost:${port}`);
            console.log(`🔌 WebSocket Server: ws://localhost:${port}`);
            console.log(`📊 Database: Connected to ${process.env.DB_NAME}`);
            console.log(`⚡ Environment: ${process.env.NODE_ENV}`);
            console.log('=====================================');
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log('🛑 SIGTERM received, shutting down gracefully');
            this.server.close(() => {
                console.log('✅ Server closed');
                if (this.dbPool) {
                    this.dbPool.end();
                    console.log('✅ Database connections closed');
                }
                process.exit(0);
            });
        });

        process.on('SIGINT', () => {
            console.log('🛑 SIGINT received, shutting down gracefully');
            this.server.close(() => {
                console.log('✅ Server closed');
                if (this.dbPool) {
                    this.dbPool.end();
                    console.log('✅ Database connections closed');
                }
                process.exit(0);
            });
        });
    }
}

// Start the server
new TempEmailServer();
