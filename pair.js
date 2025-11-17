const PastebinAPI = require('pastebin-js');
const pastebin = new PastebinAPI('EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL');
const { makeid } = require('./id');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    delay,
    makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const router = express.Router();

// Constants
const TEMP_DIR = './temp';
const DELAY_CONFIG = {
    INITIAL: 1500,
    SESSION_MESSAGE: 6000,
    FILE_READ: 5000,
    CLOSE: 100,
    RECONNECT: 10000
};

// Helper function to remove files with better error handling
function removeFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return { success: true, message: 'File does not exist' };
        }
        
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(filePath);
        }
        return { success: true, message: 'File removed successfully' };
    } catch (error) {
        console.error(`Error removing file ${filePath}:`, error);
        return { success: false, error: error.message };
    }
}

// Ensure temp directory exists
function ensureTempDir() {
    try {
        if (!fs.existsSync(TEMP_DIR)) {
            fs.mkdirSync(TEMP_DIR, { recursive: true });
        }
    } catch (error) {
        console.error('Error creating temp directory:', error);
        throw new Error('Failed to create temporary directory');
    }
}

// Validate phone number
function validatePhoneNumber(num) {
    if (!num) {
        throw new Error('Phone number is required');
    }
    
    const cleaned = num.replace(/[^0-9]/g, '');
    if (cleaned.length < 10) {
        throw new Error('Invalid phone number format');
    }
    
    return cleaned;
}

// Cleanup function for session directory
async function cleanupSession(sessionId) {
    try {
        const sessionPath = path.join(TEMP_DIR, sessionId);
        const result = removeFile(sessionPath);
        
        if (!result.success) {
            console.warn(`Failed to cleanup session ${sessionId}:`, result.error);
        }
        
        return result;
    } catch (error) {
        console.error(`Error during cleanup of session ${sessionId}:`, error);
        return { success: false, error: error.message };
    }
}

// Error response helper
function sendErrorResponse(res, message, statusCode = 500) {
    if (!res.headersSent) {
        return res.status(statusCode).json({ 
            success: false, 
            error: message 
        });
    }
    return null;
}

// Success response helper
function sendSuccessResponse(res, data) {
    if (!res.headersSent) {
        return res.json({ 
            success: true, 
            ...data
        });
    }
    return null;
}

// FIXED: Changed to '/' because index.js mounts this at '/code'
router.get('/', async (req, res) => {
    let sessionId;
    let client;

    try {
        // Validate request
        if (!req.query.number) {
            return sendErrorResponse(res, 'Phone number parameter is required', 400);
        }

        sessionId = makeid();
        
        // Ensure temp directory exists
        ensureTempDir();

        const version = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(path.join(TEMP_DIR, sessionId));

        let pairingCodeSent = false;

        client = makeWASocket({
            printQRInTerminal: false,
           // version,
            logger: pino({
                level: 'silent',
            }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            auth: {
                ...state,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
        });

        // Handle credentials update
        client.ev.on('creds.update', saveCreds);

        // Handle connection updates
        client.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            try {
                if (connection === 'open') {
                    console.log(`Session ${sessionId}: Connection opened successfully`);

                    try {
                        // Send initial message
                        await client.sendMessage(client.user.id, { 
                            text: `Generating your session_id, Wait . .` 
                        });
                        
                        await delay(DELAY_CONFIG.SESSION_MESSAGE);

                        // Read and send session data
                        const credsPath = path.join(__dirname, TEMP_DIR, sessionId, 'creds.json');
                        
                        if (!fs.existsSync(credsPath)) {
                            throw new Error('Credentials file not found');
                        }

                        const data = fs.readFileSync(credsPath);
                        await delay(DELAY_CONFIG.FILE_READ);

                        const b64data = Buffer.from(data).toString('base64');
                        const sessionMessage = await client.sendMessage(
                            client.user.id, 
                            { text: 'JUNE-MD:~' + b64data }
                        );

                        // Send success message
                        await client.sendMessage(client.user.id, {
                            text: `
  *SESSION CONNECTED*
 🔹 BOT: JUNE-MD
 🔹 TYPE: BASE64
 🔹 OWNER: Supreme
 🔹 SESSION ID: ${sessionId}
 `
                        }, { quoted: sessionMessage });

                        await delay(DELAY_CONFIG.CLOSE);
                        
                        // Close connection and cleanup
                        if (client.ws) {
                            client.ws.close();
                        }
                        
                        await cleanupSession(sessionId);

                    } catch (error) {
                        console.error(`Session ${sessionId}: Error during session setup:`, error);
                        
                        await client.sendMessage(client.user.id, { 
                            text: `❌ Error generating session: ${error.message}` 
                        });
                        
                        await cleanupSession(sessionId);
                    }

                } else if (connection === 'close') {
                    console.log(`Session ${sessionId}: Connection closed`);

                    if (lastDisconnect?.error) {
                        const statusCode = lastDisconnect.error.output?.statusCode;
                        
                        if (statusCode !== 401) {
                            console.log(`Session ${sessionId}: Attempting reconnect in ${DELAY_CONFIG.RECONNECT}ms`);
                            await delay(DELAY_CONFIG.RECONNECT);
                        } else {
                            console.log(`Session ${sessionId}: Authentication failed (401), no reconnect`);
                        }
                    }

                    // Cleanup on connection close
                    await cleanupSession(sessionId);
                }
                
                // Handle QR code generation for pairing
                if (qr && !pairingCodeSent && !client.authState.creds.registered) {
                    await delay(DELAY_CONFIG.INITIAL);
                    
                    try {
                        const validatedNumber = validatePhoneNumber(req.query.number);
                        const code = await client.requestPairingCode(validatedNumber);
                        
                        pairingCodeSent = true;
                        
                        // FIXED: Changed response format to match frontend expectations
                        sendSuccessResponse(res, { 
                            code: code,
                            sessionId: sessionId,
                            message: 'Pairing code generated successfully'
                        });
                        
                    } catch (error) {
                        console.error(`Session ${sessionId}: Error requesting pairing code:`, error);
                        sendErrorResponse(res, `Failed to generate pairing code: ${error.message}`);
                        
                        await cleanupSession(sessionId);
                        if (client.ws) {
                            client.ws.close();
                        }
                    }
                }

            } catch (handlerError) {
                console.error(`Session ${sessionId}: Error in connection handler:`, handlerError);
                await cleanupSession(sessionId);
            }
        });

        // Set timeout for the entire process (5 minutes)
        const timeout = setTimeout(async () => {
            console.log(`Session ${sessionId}: Process timeout`);
            if (!res.headersSent) {
                sendErrorResponse(res, 'Session generation timeout');
            }
            await cleanupSession(sessionId);
            if (client?.ws) {
                client.ws.close();
            }
        }, 5 * 60 * 1000);

        // Cleanup on client close
        client.ev.on('close', async () => {
            clearTimeout(timeout);
            await cleanupSession(sessionId);
        });

    } catch (error) {
        console.error(`Session setup error:`, error);
        
        // Cleanup on any error
        if (sessionId) {
            await cleanupSession(sessionId);
        }
        
        sendErrorResponse(res, `Service error: ${error.message}`);
    }
});

// Add health check endpoint
router.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'JUNE-MD Session Generator'
    });
});

// Add cleanup endpoint for manual intervention
router.delete('/session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await cleanupSession(sessionId);
        
        if (result.success) {
            sendSuccessResponse(res, { message: `Session ${sessionId} cleaned up successfully` });
        } else {
            sendErrorResponse(res, `Failed to cleanup session: ${result.error}`);
        }
    } catch (error) {
        sendErrorResponse(res, `Cleanup error: ${error.message}`);
    }
});

module.exports = router;
