const path = require('path');
require('dotenv').config();
const { randomBytes } = require('crypto');
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
const SYNC_TTL_MS = Number(process.env.SYNC_TTL_MS || 10 * 60 * 1000);

const messagesEvangeliques = [
    "Le voleur ne vient que pour dérober, égorger et détruire; Jésus est venu afin que les brebis aient la vie et qu'elles soient dans l'abondance.",
    "Jésus est le chemin, la vérité et la vie. Nul ne vient au Père que par lui.",
    "Jésus revient bientôt!",
    "Celui qui croit au Fils (Jésus) a la vie éternelle; celui qui ne croit pas au Fils ne verra point la vie, mais la colère de Dieu demeure sur lui.",
    "Si tu confesses de ta bouche le seigneur Jésus et si tu crois dans ton coeur que Dieu l'a ressuscité des morts, tu seras sauvé",
    "Car il y a un seul Dieu, et aussi un seul médiateur entre Dieu et les hommes, Jésus-Christ homme,",
    "Mais à tous ceux qui l'ont reçue (la lumière), à ceux qui croient en son nom (Jésus), elle a donné le pouvoir de devenir enfants de Dieu, lesquels sont nés, non du sang, ni de la volonté de l'homme, mais de Dieu."
];

// Stockage temporaire des contacts, évite localStorage
const tempSyncStore = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [token, value] of tempSyncStore.entries()) {
        if (value.expiresAt <= now) {
            tempSyncStore.delete(token);
        }
    }
}, 60_000).unref();

function createToken() {
    return randomBytes(16).toString('hex');
}

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
            socket.emit('error', 'Erreur lors de la génération du code.');
        }
    });

    socket.on('start_final_broadcast', async (data) => {
        if (!isWhatsAppReady) {
            return socket.emit('erreur_diffusion', "L'envoi a échoué : WhatsApp s'est déconnecté suite au manque de mémoire. Reconnectez-vous.");
        }

        const { contacts, messageIndex } = data || {};
        const idx = Number(messageIndex || 0);
        const messageBase = messagesEvangeliques[idx] || messagesEvangeliques[0];

        if (!Array.isArray(contacts) || contacts.length === 0) {
            return socket.emit('erreur_diffusion', 'Aucun contact valide à envoyer.');
        }

        envoyerMessagesEnMasse(contacts, messageBase);
    });
});

client.initialize();

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/oauth2callback`
);

async function envoyerMessagesEnMasse(contacts, messageBase) {
    let envoyés = 0;
    const total = contacts.length;
    const lienMouvement = `\n\n👉 Joindre le mouvement : ${BASE_URL}`;
    const messageFinal = messageBase + lienMouvement;

    for (const contact of contacts) {
        try {
            const cleanNum = normaliserNumeroRdc(contact.numero);
            if (!cleanNum) continue;

            const chatId = `${cleanNum}@c.us`;
            await client.sendMessage(chatId, messageFinal);

            envoyés++;
            io.emit('progress', {
                current: envoyés,
                total,
                lastContact: contact.nom || 'Inconnu'
            });

            await sleep(1200);
        } catch (error) {
            console.error(`❌ Échec pour ${contact.nom || 'Inconnu'}:`, error.message);
        }
    }

    io.emit('finished', { total: envoyés });
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

        const service = google.people({ version: 'v1', auth: oauth2Client });

        const response = await service.people.connections.list({
            resourceName: 'people/me',
            pageSize: MAX_CONTACTS,
            personFields: 'names,phoneNumbers'
        });

        const contacts = (response.data.connections || [])
            .map(p => ({
                nom: p.names && p.names[0] ? p.names[0].displayName : 'Inconnu',
                numero: p.phoneNumbers && p.phoneNumbers[0] ? p.phoneNumbers[0].value : null
            }))
            .filter(c => c.numero)
            .slice(0, MAX_CONTACTS);

        const token = createToken();
        tempSyncStore.set(token, {
            contacts,
            messageIndex: String(state || 0),
            expiresAt: Date.now() + SYNC_TTL_MS
        });

        res.redirect(302, `/?syncToken=${token}`);
    } catch (error) {
        console.error("Erreur OAuth:", error);
        res.status(500).send("Erreur de synchronisation.");
    }
});

app.get('/sync-data', (req, res) => {
    const token = req.query.token;

    if (!token || !tempSyncStore.has(token)) {
        return res.status(404).json({ error: 'Données de synchronisation introuvables ou expirées.' });
    }

    const payload = tempSyncStore.get(token);

    // On supprime après lecture pour alléger la mémoire
    tempSyncStore.delete(token);

    res.json({
        contacts: payload.contacts,
        messageIndex: payload.messageIndex
    });
});

app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        whatsappReady: isWhatsAppReady,
        tempSyncItems: tempSyncStore.size
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Serveur lancé sur le port ${PORT}`));