const path = require('path');
require('dotenv').config();
const { google } = require('googleapis');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use('/images', express.static(__dirname + '/images'));
const server = http.createServer(app);
const io = new Server(server);
const BASE_URL = process.env.BASE_URL || "https://gabriel-diffusion.onrender.com";

// Variable pour mémoriser l'état de la connexion WhatsApp
let isWhatsAppReady = false;

const messagesEvangeliques = [
    "Le voleur ne vient que pour dérober, égorger et détruire; Jésus est venu afin que les brebis aient la vie et qu'elles soient dans l' abondance.",
    "Jésus est le chemin, la vérité et la vie. Nul ne vient au Père que par lui.",
    "Jésus revient bientôt!",
    "Celui qui croit au Fils (Jésus) a la vie éternelle; celui qui ne croit pas au Fils ne verra point la vie, mais la colère de Dieu demeure sur lui.",
    "Si tu confesses de ta bouche le seigneur Jésus et si tu crois dans ton coeur que Dieu l'a ressuscité des morts, tu seras sauvé",
    "Car il y a un seul Dieu, et aussi un seul médiateur entre Dieu et les hommes, Jésus-Christ homme,",
    "Mais à tous ceux qui l'ont reçue (la lumière), à ceux qui croient en son nom (Jésus), elle a donné le pouvoir de devenir enfants de Dieu, lesquels sont nés, non du sang, ni de la volonté de l'homme, mais de Dieu."
];

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
      '--js-flags="--max-old-space-size=150"' // Limite la mémoire du moteur JS
    ]
  }
});

client.on('qr', async (qr) => {
    try {
        isWhatsAppReady = false;
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
    io.emit('status', 'WhatsApp déconnecté ! ❌');
});

io.on('connection', (socket) => {
    // Dès qu'un utilisateur (re)connecte sa page, on lui envoie l'état actuel de WhatsApp
    if (isWhatsAppReady) {
        socket.emit('status', 'WhatsApp est connecté ! ✅');
    }

    socket.on('request_pairing_code', async (phoneNumber) => {
        try {
            const cleanNumber = phoneNumber.replace(/\D/g, '');
            const code = await client.requestPairingCode(cleanNumber);
            socket.emit('pairing_code', code);
        } catch (err) {
            socket.emit('error', 'Erreur lors de la génération du code.');
        }
    });

    socket.on('start_final_broadcast', async (data) => {
        const { contacts, messageIndex } = data;
        const messageBase = messagesEvangeliques[messageIndex];
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
            let cleanNum = contact.numero.replace(/\D/g, '');
            
            // Correction automatique pour la RDC : si le numéro commence par 0 et fait 10 chiffres (ex: 0906253050)
            if (cleanNum.startsWith('0') && cleanNum.length === 10) {
                cleanNum = '243' + cleanNum.substring(1);
            }

            const chatId = `${cleanNum}@c.us`;
            await client.sendMessage(chatId, messageFinal);
            envoyés++;
            io.emit('progress', { current: envoyés, total: total, lastContact: contact.nom });
            await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));
        } catch (error) {
            console.error(`❌ Échec pour ${contact.nom}:`, error.message);
        }
    }
    io.emit('finished', { total: envoyés });
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
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
            pageSize: 1000,
            personFields: 'names,phoneNumbers',
        });

        const contacts = (response.data.connections || [])
            .map(p => ({
                nom: p.names ? p.names[0].displayName : 'Inconnu',
                numero: p.phoneNumbers ? p.phoneNumbers[0].value : null
            }))
            .filter(c => c.numero);

        const contactsJSON = JSON.stringify(contacts);
        res.send(`
            <script>
                localStorage.setItem('temp_contacts', '${contactsJSON.replace(/'/g, "\\'")}');
                localStorage.setItem('temp_msg_idx', '${state}');
                window.location.href = '/';
            </script>
        `);
    } catch (error) {
        res.status(500).send("Erreur de synchronisation.");
    }
});

app.get('/privacy', (req, res) => { res.sendFile(path.join(__dirname, 'privacy.html')); });
app.get('/terms', (req, res) => { res.sendFile(path.join(__dirname, 'terms.html')); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Serveur lancé sur le port ${PORT}`));