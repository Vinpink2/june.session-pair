const PastebinAPI = require('pastebin-js');
const pastebin = new PastebinAPI('EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL');
const { makeid } = require('./id');
const express = require('express');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    version,
    delay,
    makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const router = express.Router();

// Helper function to remove files
function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath, { recursive: true, force: true });
}

// Route handler
router.get('/', async (req, res) => {
    const id = makeid();
    let num = req.query.number;

    async function RAVEN() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);
        try {
      const client = makeWASocket({
        printQRInTerminal: false,
        version: [2, 3000, 1023223821],
        logger: pino({
          level: 'silent',
        }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        auth: state,
      })

            if (!client.authState.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                const code = await client.requestPairingCode(num);

                 if (!res.headersSent) {
                    await res.send({ code });
                }
            }

            client.ev.on('creds.update', saveCreds);
            client.ev.on('connection.update', async (s) => {
                const { connection, lastDisconnect } = s;
                if (connection === 'open') {
                await client.sendMessage(client.user.id, { text: `Generating your session, Wait a moment. . .` });
                    await delay(50000);
                    
                    const data = fs.readFileSync(__dirname + `/temp/${id}/creds.json`);
                    await delay(8000);
                    const b64data = Buffer.from(data).toString('base64');
                    const session = await client.sendMessage(client.user.id, { text: '' + b64data });

                    // Send message after session
                    await client.sendMessage(client.user.id, {text: "" }, { quoted: session });
                    
                    await delay(100);
                    await client.ws.close();
                    removeFile('./temp/' + id);
                } else if (connection === 'close' && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode !== 401) {
                    await delay(10000);
                    RAVEN();
                }
            });
        } catch (err) {
            console.log('service restarted', err);
            removeFile('./temp/' + id);
            if (!res.headersSent) {
                await res.send({ code: 'Service Currently Unavailable' });
            }
        }
    }

    await RAVEN();
});

module.exports = router;



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
    version,
    delay,
    makeCacheableSignalKeyStore,
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
                version: [2, 3000, 1023223821],
                logger: pino({
                    level: 'silent',
                }),
                browser: ['Ubuntu', 'Chrome', '20.0.04'],
                auth: {
                    ...state,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
                },
            });

            if (!client.authState.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                
                if (!num) {
                    throw new Error('Invalid phone number');
                }

                const code = await client.requestPairingCode(num);

                if (!res.headersSent) {
                    res.send({ code });
                }
            }

            client.ev.on('creds.update', saveCreds);
            
            client.ev.on('connection.update', async (s) => {
                const { connection, lastDisconnect } = s;
                
                if (connection === 'open') {
                    try {
                        await client.sendMessage(client.user.id, { 
                            text: `Generating your session, Wait a moment. . .` 
                        });
                        
                        await delay(50000);
                        
                        const credsPath = path.join(authPath, 'creds.json');
                        if (!fs.existsSync(credsPath)) {
                            throw new Error('Credentials file not found');
                        }
                        
                        const data = fs.readFileSync(credsPath);
                        await delay(8000);
                        
                        const b64data = Buffer.from(data).toString('base64');
                        const session = await client.sendMessage(client.user.id, { 
                            text: b64data 
                        });

                        // Send message after session
                        await client.sendMessage(client.user.id, { 
                            text: "Session generated successfully!" 
                        }, { quoted: session });
                        
                        await delay(100);
                        await client.ws.close();
                        removeFile(authPath);
                        
                    } catch (error) {
                        console.error('Error in connection open:', error);
                        await client.sendMessage(client.user.id, { 
                            text: `Error: ${error.message}` 
                        });
                        removeFile(authPath);
                    }
                    
                } else if (connection === 'close') {
                    if (lastDisconnect?.error?.output?.statusCode !== 401) {
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
