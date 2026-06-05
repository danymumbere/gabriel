const path = require('path');
require('dotenv').config();
const { google } = require('googleapis');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
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
const PAGE_SIZE = 50;
const SEND_DELAY_MS = 1200;

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

// --- CONFIGURATION BAILEYS ---
let sock;
let isWhatsAppReady = false;
let broadcastRunning = false;

async function connectToWhatsApp() {
    // Sauvegarde la session dans un dossier local pour éviter de se reconnecter
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), // Masque les logs internes de Baileys
        browser: ["Ubuntu", "Chrome", "20.0.04"] // Facilite le couplage par code
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const url = await QRCode.toDataURL(qr);
                io.emit('qr_code', url);
            } catch (err) {
                console.error('Erreur génération QR:', err);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            isWhatsAppReady = false;
            
            if (shouldReconnect) {
                io.emit('status', "Reconnexion à WhatsApp en cours...");
                connectToWhatsApp(); // Reconnexion automatique
            } else {
                io.emit('status', "WhatsApp s'est déconnecté. Veuillez relier l'appareil.");
            }
        } else if (connection === 'open') {
            isWhatsAppReady = true;
            io.emit('status', 'WhatsApp est connecté ! ✅');
        }
    });
}

// Initialisation au démarrage
connectToWhatsApp();

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    if (isWhatsAppReady) {
        socket.emit('status', 'WhatsApp est connecté ! ✅');
    }

    socket.on('request_pairing_code', async (phoneNumber) => {
        try {
            const cleanNumber = String(phoneNumber).replace(/\D/g, '');
            // Baileys a parfois besoin d'un léger délai pour générer le code
            setTimeout(async () => {
                const code = await sock.requestPairingCode(cleanNumber);
                socket.emit('pairing_code', code);
            }, 1000);
        } catch (err) {
            console.error('Erreur pairing:', err);
            socket.emit('error', 'Erreur lors de la génération du code. Vérifiez le numéro.');
        }
    });
});

// --- GOOGLE OAUTH & LOGIQUE D'ENVOI ---
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/oauth2callback`
);

async function envoyerMessagesParPages(messageBase) {
    if (broadcastRunning) {
        io.emit('erreur_diffusion', 'Une diffusion est déjà en cours.');
        return;
    }
    if (!isWhatsAppReady) {
        io.emit('erreur_diffusion', "WhatsApp n'est pas encore connecté.");
        return;
    }

    broadcastRunning = true;
    const service = google.people({ version: 'v1', auth: oauth2Client });
    const lienMouvement = `\n\n👉 Joindre le mouvement : ${BASE_URL}`;
    const messageFinal = messageBase + lienMouvement;

    let sent = 0;
    let inspected = 0;
    let pageToken = undefined;

    io.emit('status', '✅ Lecture des contacts par lots...');

    try {
        while (inspected < MAX_CONTACTS) {
            const remaining = MAX_CONTACTS - inspected;
            const response = await service.people.connections.list({
                resourceName: 'people/me',
                pageSize: Math.min(PAGE_SIZE, remaining),
                pageToken,
                personFields: 'names,phoneNumbers'
            });

            const connections = Array.isArray(response.data.connections) ? response.data.connections : [];
            if (connections.length === 0) break;

            for (const person of connections) {
                if (inspected >= MAX_CONTACTS) break;
                inspected++;

                const nom = person.names && person.names[0] ? person.names[0].displayName : 'Inconnu';
                const numero = person.phoneNumbers && person.phoneNumbers[0] ? person.phoneNumbers[0].value : null;
                const cleanNum = normaliserNumeroRdc(numero);

                if (!cleanNum) continue;

                try {
                    // Vérifie si le numéro possède un compte WhatsApp avec Baileys
                    const [result] = await sock.onWhatsApp(cleanNum);

                    if (!result || !result.exists) {
                        console.log(`Numéro non trouvé sur WhatsApp: ${nom} - ${cleanNum}`);
                        continue;
                    }

                    // Envoi du message via Baileys (utilise result.jid)
                    await sock.sendMessage(result.jid, { text: messageFinal });

                    sent++;
                    io.emit('progress', {
                        current: sent,
                        total: MAX_CONTACTS,
                        lastContact: nom
                    });

                    await sleep(SEND_DELAY_MS);
                } catch (error) {
                    console.error(`❌ Échec pour ${nom}:`, error.message);
                }
            }

            pageToken = response.data.nextPageToken;
            if (!pageToken) break;
        }

        io.emit('finished', { total: sent });
    } catch (error) {
        console.error('Erreur pendant l’envoi:', error);
        io.emit('erreur_diffusion', 'Erreur pendant la lecture ou l’envoi des contacts.');
    } finally {
        broadcastRunning = false;
    }
}

// --- ROUTES EXPRESS ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/messages', (req, res) => res.json(messagesEvangeliques));

app.get('/auth', (req, res) => {
    const msgIdx = req.query.msgIdx || '0';
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

        res.send(`
            <script>
                if (window.opener) {
                    window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS', msgIdx: ${messageIndex} }, '*');
                    window.close();
                } else {
                    window.location.href = '/?envoi=1&msgIdx=${messageIndex}';
                }
            </script>
        `);
    } catch (error) {
        io.emit('erreur_diffusion', 'Erreur de synchronisation.');
        res.send(`
            <script>
                if (window.opener) {
                    window.opener.postMessage({ type: 'GOOGLE_AUTH_ERROR' }, '*');
                    window.close();
                } else {
                    window.location.href = '/?error=1';
                }
            </script>
        `);
    }
});

app.get('/start-broadcast', async (req, res) => {
    const messageIndex = Number(req.query.msgIdx || 0);
    const messageBase = messagesEvangeliques[messageIndex] || messagesEvangeliques[0];

    if (broadcastRunning) {
        return res.status(409).json({ ok: false, message: 'Diffusion déjà en cours.' });
    }
    if (!oauth2Client.credentials || !oauth2Client.credentials.access_token) {
        return res.status(401).json({ ok: false, message: 'Google non authentifié.' });
    }

    res.status(202).json({ ok: true, message: 'Diffusion lancée.' });

    setImmediate(() => {
        envoyerMessagesParPages(messageBase).catch(err => {
            console.error('Erreur en arrière-plan:', err);
            io.emit('erreur_diffusion', 'Erreur inattendue pendant l’envoi.');
        });
    });
});

app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/health', (req, res) => {
    res.json({ ok: true, whatsappReady: isWhatsAppReady, broadcastRunning });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Serveur lancé sur le port ${PORT} avec Baileys !`));