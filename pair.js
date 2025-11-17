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
    delay,
} = require("@whiskeysockets/baileys");

const router = express.Router();

// Helper function to remove files
function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    try {
        fs.rmSync(filePath, { recursive: true, force: true });
        return true;
    } catch (error) {
        console.error('Error removing file:', error);
        return false;
    }
}

// Ensure temp directory exists
function ensureTempDir() {
    const tempDir = './temp';
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
}

// Route handler
router.get('/', async (req, res) => {
    const id = makeid();
    let num = req.query.number;

    // Validate number parameter
    if (!num) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    ensureTempDir();

    async function RAVEN() {
        const authPath = './temp/' + id;
        
        try {
            const { state, saveCreds } = await useMultiFileAuthState(authPath);
            
            const client = makeWASocket({
                printQRInTerminal: false,
                logger: pino({
                    level: 'silent',
                }),
                browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
                auth: {
                    creds: state.creds,
                    keys: state.keys,
                },
            });

            // Handle credentials update
            client.ev.on('creds.update', saveCreds);

            if (!state.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                
                if (!num) {
                    throw new Error('Invalid phone number');
                }

                // In latest version, use phone connection instead of pairing code
                try {
                    const code = await client.requestPairingCode(num);
                    
                    if (!res.headersSent) {
                        res.send({ code });
                    }
                } catch (pairError) {
                    // Fallback for older number registration method
                    if (!res.headersSent) {
                        res.status(500).send({ 
                            error: 'Failed to generate pairing code',
                            message: pairError.message 
                        });
                    }
                    return;
                }
            }

            client.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (connection === 'open') {
                    try {
                        await client.sendMessage(client.user.id, { 
                            text: `Generating your session, Wait a moment. . .` 
                        });
                        
                        await delay(30000);
                        
                        const credsPath = path.join(authPath, 'creds.json');
                        if (!fs.existsSync(credsPath)) {
                            throw new Error('Credentials file not found');
                        }
                        
                        const data = fs.readFileSync(credsPath);
                        await delay(5000);
                        
                        const b64data = Buffer.from(data).toString('base64');
                        const session = await client.sendMessage(client.user.id, { 
                            text: b64data 
                        });

                        // Send confirmation message
                        await client.sendMessage(client.user.id, { 
                            text: "Session generated successfully!" 
                        }, { quoted: session });
                        
                        await delay(100);
                        await client.end(null);
                        removeFile(authPath);
                        
                    } catch (error) {
                        console.error('Error in connection open:', error);
                        try {
                            await client.sendMessage(client.user.id, { 
                                text: `Error: ${error.message}` 
                            });
                        } catch (e) {
                            console.error('Failed to send error message:', e);
                        }
                        removeFile(authPath);
                    }
                    
                } else if (connection === 'close') {
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
                    
                    if (shouldReconnect) {
                        await delay(10000);
                        RAVEN().catch(console.error);
                    } else {
                        removeFile(authPath);
                    }
                }
            });

        } catch (err) {
            console.log('Error in RAVEN:', err);
            removeFile('./temp/' + id);
            
            if (!res.headersSent) {
                res.status(500).send({ 
                    error: 'Service Currently Unavailable',
                    message: err.message 
                });
            }
        }
    }

    await RAVEN();
});

module.exports = router;
