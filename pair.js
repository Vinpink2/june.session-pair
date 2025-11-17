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

    // Validate number parameter
    if (!num) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    async function RAVEN() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);
        try {
            const client = makeWASocket({
                printQRInTerminal: false,
                version: [2, 3000, 1025190524],
                logger: pino({
                    level: 'silent',
                }),
                browser: ['Ubuntu', 'Chrome', '20.0.04'],
                auth: state,
            });

            if (!client.authState.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                
                // Validate number format after cleaning
                if (!num || num.length < 10) {
                    throw new Error('Invalid phone number format');
                }
                
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
                    
                    // Check if creds file exists before reading
                    const credsPath = __dirname + `/temp/${id}/creds.json`;
                    if (!fs.existsSync(credsPath)) {
                        throw new Error('Credentials file not found');
                    }
                    
                    const data = fs.readFileSync(credsPath);
                    await delay(8000);
                    const b64data = Buffer.from(data).toString('base64');
                    const session = await client.sendMessage(client.user.id, { text: '' + b64data });

                    // Send message after session
                    await client.sendMessage(client.user.id, {
                        text: `

『 SESSION CONNECTED』
🔷 Bot
🔷 By  
` 
                    }, { quoted: session });
                    
                    await delay(100);
                    await client.ws.close();
                    removeFile('./temp/' + id);
                } else if (connection === 'close' && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode !== 401) {
                    await delay(10000);
                    RAVEN();
                }
            });
        } catch (err) {
            console.log('service error:', err);
            removeFile('./temp/' + id);
            if (!res.headersSent) {
                await res.status(500).send({ 
                    code: 'Service Currently Unavailable',
                    error: err.message 
                });
            }
        }
    }

    await RAVEN();
});

module.exports = router;
