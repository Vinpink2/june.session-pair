const PastebinAPI = require('pastebin-js');
const pastebin = new PastebinAPI('EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL');
const { makeid } = require('./id');
const QRCode = require('qrcode');
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const pino = require("pino");
const {
    default: RavenConnect,
    useMultiFileAuthState,
    jidNormalizedUser,
    Browsers,
    delay,
    makeInMemoryStore,
} = require("@whiskeysockets/baileys");

// Configuration
const CONFIG = {
    SESSION_TIMEOUT: 120000, // 2 minutes
    CLEANUP_DELAY: 5000,
    MAX_RETRIES: 3,
    TEMP_DIR: './temp'
};

// Utility functions
function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    try {
        fs.rmSync(filePath, { recursive: true, force: true });
        return true;
    } catch (error) {
        console.error(`Error removing file ${filePath}:`, error);
        return false;
    }
}

function cleanupSession(sessionId) {
    setTimeout(() => {
        removeFile(`${CONFIG.TEMP_DIR}/${sessionId}`);
    }, CONFIG.CLEANUP_DELAY);
}

function validateSessionId(sessionId) {
    return /^[a-zA-Z0-9_-]+$/.test(sessionId) && sessionId.length <= 50;
}

// Rate limiting storage
const activeSessions = new Map();

// Rate limiting middleware
function rateLimit(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const windowStart = now - 60000; // 1 minute window
    
    if (activeSessions.has(ip)) {
        const requests = activeSessions.get(ip).filter(time => time > windowStart);
        if (requests.length >= 3) { // Max 3 requests per minute per IP
            return res.status(429).json({
                error: "Too many requests",
                message: "Please wait before generating another session"
            });
        }
        requests.push(now);
        activeSessions.set(ip, requests);
    } else {
        activeSessions.set(ip, [now]);
    }
    
    // Cleanup old entries periodically
    if (Math.random() < 0.1) { // 10% chance to cleanup
        for (let [key, times] of activeSessions.entries()) {
            const validTimes = times.filter(time => time > windowStart);
            if (validTimes.length === 0) {
                activeSessions.delete(key);
            } else {
                activeSessions.set(key, validTimes);
            }
        }
    }
    
    next();
}

router.get('/', rateLimit, async (req, res) => {
    const sessionId = makeid();
    
    if (!validateSessionId(sessionId)) {
        return res.status(400).json({
            error: "Invalid session ID generated"
        });
    }

    // Set response headers
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    let client;
    let sessionTimeout;

    const cleanup = async () => {
        if (sessionTimeout) clearTimeout(sessionTimeout);
        if (client) {
            try {
                await client.ws.close();
            } catch (error) {
                console.error('Error closing client:', error);
            }
        }
        cleanupSession(sessionId);
    };

    // Session timeout handler
    sessionTimeout = setTimeout(async () => {
        if (!res.headersSent) {
            res.status(408).json({
                error: "Session timeout",
                message: "QR code expired. Please try again."
            });
        }
        await cleanup();
    }, CONFIG.SESSION_TIMEOUT);

    async function initializeRaven() {
        const sessionPath = `${CONFIG.TEMP_DIR}/${sessionId}`;
        
        try {
            // Create temp directory if it doesn't exist
            if (!fs.existsSync(CONFIG.TEMP_DIR)) {
                fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

            client = RavenConnect({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS("Desktop"),
                markOnlineOnConnect: false,
                syncFullHistory: false,
                linkPreviewImageThumbnailWidth: 0,
                generateHighQualityLinkPreview: false,
            });

            client.ev.on('creds.update', saveCreds);
            
            client.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;

                try {
                    if (qr) {
                        const qrBuffer = await QRCode.toBuffer(qr, {
                            errorCorrectionLevel: 'M',
                            margin: 2,
                            scale: 6,
                            width: 400
                        });
                        
                        if (!res.headersSent) {
                            res.end(qrBuffer);
                        }
                    }

                    if (connection === "open") {
                        clearTimeout(sessionTimeout);
                        
                        try {
                            await client.sendMessage(client.user.id, { 
                                text: '🚀 Generating your session... Please wait.' 
                            });

                            await delay(3000);

                            // Read and encode session data
                            const credsPath = `${sessionPath}/creds.json`;
                            if (!fs.existsSync(credsPath)) {
                                throw new Error('Session credentials not found');
                            }

                            const data = await fs.promises.readFile(credsPath);
                            const base64Data = Buffer.from(data).toString('base64');

                            // Send session data to user
                            const sessionMessage = await client.sendMessage(
                                client.user.id, 
                                { text: base64Data }
                            );

                            const successMessage = `┏━━━❑\n┃🔹 Owner: Supreme\n┃🔹 Type: Base64\n┃🔹 Status: ✅ Active\n┃🔹 Generated: ${new Date().toLocaleString()}\n┗━━━❒\n\n⚠️ Keep this session data secure and don't share it with anyone!`;

                            await client.sendMessage(
                                client.user.id, 
                                { text: successMessage }, 
                                { quoted: sessionMessage }
                            );

                            await delay(1000);
                            await cleanup();

                        } catch (error) {
                            console.error('Error during session generation:', error);
                            await client.sendMessage(client.user.id, { 
                                text: '❌ Error generating session. Please try again.' 
                            });
                            await cleanup();
                        }

                    } else if (connection === "close" && lastDisconnect) {
                        const error = lastDisconnect.error;
                        if (error && error.output && error.output.statusCode !== 401) {
                            console.log('Connection closed, attempting reconnect...');
                            await delay(10000);
                            await cleanup();
                            if (!res.headersSent) {
                                res.status(503).json({
                                    error: "Connection issue",
                                    message: "Please try again"
                                });
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error in connection update:', error);
                    await cleanup();
                }
            });

            // Handle client errors
            client.ev.on("connection.update", (update) => {
                if (update.qr) {
                    console.log(`QR generated for session: ${sessionId}`);
                }
            });

        } catch (error) {
            console.error('Initialization error:', error);
            
            if (!res.headersSent) {
                res.status(500).json({
                    error: "Service unavailable",
                    message: "Failed to initialize session service"
                });
            }
            await cleanup();
        }
    }

    try {
        await initializeRaven();
    } catch (error) {
        console.error('Failed to start Raven:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: "Internal server error"
            });
        }
        await cleanup();
    }

    // Handle client disconnect
    req.on('close', async () => {
        if (!res.headersSent) {
            await cleanup();
        }
    });
});

// Health check endpoint
router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        activeSessions: activeSessions.size
    });
});

// Cleanup endpoint for manual intervention
router.delete('/cleanup/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    if (!validateSessionId(sessionId)) {
        return res.status(400).json({ error: "Invalid session ID" });
    }

    const success = removeFile(`${CONFIG.TEMP_DIR}/${sessionId}`);
    res.json({
        success,
        message: success ? "Session cleaned up" : "Session not found"
    });
});

module.exports = router;
