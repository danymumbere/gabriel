// db.js — Persistance MongoDB Atlas pour le journal privé du disciple.
// Singleton : une seule connexion partagée pour toute la vie du processus.
const { MongoClient, ObjectId } = require('mongodb');

const uri = process.env.MONGODB_URI;
const DB_NAME = 'gabriel';
const COL_JOURNAL = 'journal_entries';

let client = null;
let collection = null;
let connecting = null;

// Initialise la connexion (idempotent). On crée aussi l'index
// de requête du journal une fois pour toutes.
async function initDb() {
    if (collection) return collection;
    if (connecting) return connecting; // évite le double-init en cas d'appels concurrents

    connecting = (async () => {
        if (!uri) {
            throw new Error('MONGODB_URI manquant dans les variables d\'environnement.');
        }
        client = new MongoClient(uri, {
            serverSelectionTimeoutMS: 10000
        });
        await client.connect();
        const db = client.db(DB_NAME);
        collection = db.collection(COL_JOURNAL);
        // Index : lister les entrées d'un utilisateur par date décroissante.
        await collection.createIndex(
            { user_id: 1, created_at: -1 }
        );
        console.log('✅ Connecté à MongoDB Atlas');
        return collection;
    })();

    try {
        return await connecting;
    } finally {
        connecting = null;
    }
}

// True si Atlas est configuré (MONGODB_URI présent).
function isConfigured() {
    return Boolean(uri);
}

// Ajoute une entrée de journal. Renvoie le document créé (sans _id brut).
async function addEntry({ userId, stepKey, content }) {
    await initDb();
    const doc = {
        user_id: String(userId),
        step_key: stepKey || null,
        content: String(content),
        created_at: new Date()
    };
    const result = await collection.insertOne(doc);
    return {
        id: result.insertedId.toString(),
        user_id: doc.user_id,
        step_key: doc.step_key,
        content: doc.content,
        created_at: doc.created_at
    };
}

// Liste les entrées d'un utilisateur (les plus récentes d'abord).
async function listEntries(userId) {
    await initDb();
    const docs = await collection
        .find({ user_id: String(userId) })
        .sort({ created_at: -1 })
        .toArray();
    return docs.map(d => ({
        id: d._id.toString(),
        step_key: d.step_key,
        content: d.content,
        created_at: d.created_at
    }));
}

// Supprime une entrée appartenant à l'utilisateur (vérif d'appartenance).
// Renvoie true si supprimé, false si introuvable / non autorisé.
async function deleteEntry(id, userId) {
    await initDb();
    if (!ObjectId.isValid(id)) return false;
    const result = await collection.deleteOne({
        _id: new ObjectId(id),
        user_id: String(userId)
    });
    return result.deletedCount === 1;
}

module.exports = {
    initDb,
    isConfigured,
    addEntry,
    listEntries,
    deleteEntry
};
