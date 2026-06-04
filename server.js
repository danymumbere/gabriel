const path = require('path');
require('dotenv').config();
const { google } = require('googleapis');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.disable('x-powered-by');

app.use('/images', express.static(path.join(__dirname, 'images'), {
    maxAge: '7d',
    etag: true
}));

const server = http.createServer(app);
const io = new Server(server, {
    transports: ['websocket', 'polling']
});

const BASE_URL = process.env.BASE_URL || 'https://gabriel-diffusion.onrender.com';
const MAX_CONTACTS = Number(process.env.MAX_CONTACTS || 120);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 50);
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 1200);

const messagesEvangeliques = [
    "Le voleur ne vient que pour dérober, égorger et détruire; Jésus est venu afin que les brebis aient la vie et qu'elles soient dans l'abondance.",
    "Jésus est le chemin, la vérité et la vie. Nul ne vient au Père que par lui.",
    "Jésus revient bientôt!",
    "Celui qui croit au Fils (Jésus) a la vie éternelle; celui qui ne croit pas au Fils ne verra point la vie, mais la colère de Dieu demeure sur lui.",
    "Si tu confesses de ta bouche le seigneur Jésus et si tu crois dans ton coeur que Dieu l'a ressuscité des morts, tu seras sauvé",
    "Car il y a un seul Dieu, et aussi un seul médiateur entre Dieu et les hommes, Jésus-Christ homme,",
    "Mais à tous ceux qui l'ont reçue (la lumière), à ceux qui croient en son nom (Jésus), elle a donné le pouvoir de devenir enfants de Dieu, lesquels sont nés, non du sang, ni de la volonté de l'homme, mais de Dieu."
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normaliserNumeroRdc(numero) {
    let cleanNum = String(numero || '').replace(/\D/g, '');

    if (cleanNum.startsWith('0') && cleanNum.length === 10) {
        cleanNum = '243' + cleanNum.substring(1);
    } else if (!cleanNum.startsWith('243') && cleanNum.length === 9) {
        cleanNum = '243' + cleanNum;
    }

    return cleanNum;
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/data/.wwebjs_auth' }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        headless: true,
        handleSIGINT: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--no-first-run',
            '--mute-audio',
            '--hide-scrollbars'
        ]
    }
});

let isWhatsAppReady = false;

client.on('qr', async (qr) => {
    try {
        const url = await QRCode.toDataURL(qr);
        io.emit('qr_code', url);
    } catch (err) {
        console.error('Erreur QR:', err);
    }
});

client.on('ready', () => {
    isWhatsAppReady = true;
    io.emit('status', 'WhatsApp est connecté ! ✅');
});

client.on('disconnected', () => {
    isWhatsAppReady = false;
    io.emit('status', "WhatsApp s'est déconnecté.");
});

client.on('auth_failure', (msg) => {
    isWhatsAppReady = false;
    console.error('Auth failure:', msg);
});

io.on('connection', (socket) => {
    if (isWhatsAppReady) {
        socket.emit('status', 'WhatsApp est connecté ! ✅');
    }

    socket.on('request_pairing_code', async (phoneNumber) => {
        try {
            const cleanNumber = String(phoneNumber).replace(/\D/g, '');
            const code = await client.requestPairingCode(cleanNumber);
            socket.emit('pairing_code', code);
        } catch (err) {
            console.error('Erreur pairing:', err);
            socket.emit('error', 'Erreur lors de la génération du code.');
        }
    });
});

client.initialize();

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/oauth2callback`
);

async function envoyerMessagesParPages(messageBase) {
    const service = google.people({ version: 'v1', auth: oauth2Client });
    const lienMouvement = `\n\n👉 Joindre le mouvement : ${BASE_URL}`;
    const messageFinal = messageBase + lienMouvement;

    let sent = 0;
    let pageToken = undefined;

    io.emit('status', '✅ Synchronisation Google terminée. Lecture des contacts par lots...');

    try {
        while (sent < MAX_CONTACTS) {
            const remaining = MAX_CONTACTS - sent;
            const response = await service.people.connections.list({
                resourceName: 'people/me',
                pageSize: Math.min(PAGE_SIZE, remaining),
                pageToken,
                personFields: 'names,phoneNumbers'
            });

            const connections = Array.isArray(response.data.connections) ? response.data.connections : [];
            if (connections.length === 0) {
                break;
            }

            for (const person of connections) {
                if (sent >= MAX_CONTACTS) break;

                const nom = person.names && person.names[0] ? person.names[0].displayName : 'Inconnu';
                const numero = person.phoneNumbers && person.phoneNumbers[0] ? person.phoneNumbers[0].value : null;
                const cleanNum = normaliserNumeroRdc(numero);

                if (!cleanNum) {
                    continue;
                }

                try {
                    const chatId = `${cleanNum}@c.us`;
                    await client.sendMessage(chatId, messageFinal);

                    sent++;
                    io.emit('progress', {
                        current: sent,
                        lastContact: nom
                    });

                    await sleep(SEND_DELAY_MS);
                } catch (error) {
                    console.error(`❌ Échec pour ${nom}:`, error.message);
                }
            }

            pageToken = response.data.nextPageToken;
            if (!pageToken) {
                break;
            }
        }

        io.emit('finished', { total: sent });
    } catch (error) {
        console.error('Erreur pendant l’envoi par pages:', error);
        io.emit('erreur_diffusion', 'Erreur pendant la lecture ou l’envoi des contacts.');
    }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/messages', (req, res) => res.json(messagesEvangeliques));

app.get('/auth', (req, res) => {
    const msgIdx = req.query.msgIdx || "0";
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/contacts.readonly'],
        state: msgIdx
    });
    res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
    const { code, state } = req.query;

    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const messageIndex = Number(state || 0);
        const messageBase = messagesEvangeliques[messageIndex] || messagesEvangeliques[0];

        io.emit('status', '✅ Auth Google reçue. Préparation de l’envoi...');
        void envoyerMessagesParPages(messageBase);

        res.redirect(302, '/?envoi=1');
    } catch (error) {
        console.error("Erreur OAuth:", error);
        io.emit('erreur_diffusion', 'Erreur de synchronisation ou d’envoi.');
        res.status(500).send("Erreur de synchronisation.");
    }
});

app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        whatsappReady: isWhatsAppReady
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Serveur lancé sur le port ${PORT}`));