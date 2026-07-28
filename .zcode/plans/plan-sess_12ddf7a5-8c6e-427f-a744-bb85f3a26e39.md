## Plan d'implémentation — Roadmap du disciple + Exclusion de contacts + Vérification versets

*(Révision : persistance basculée de SQLite vers **MongoDB Atlas** pour rester gratuit ET persistant sur Render.)*

---

### Phase 1 — Persistance MongoDB Atlas (fondation)

**Dépendance** : `mongodb` (driver Node.js officiel v6+, PAS Mongoose — plus léger, cohérent avec le style minimal du projet).

**Configuration Atlas (à faire de ton côté, je te guide)** :
1. Créer un cluster gratuit **M0** sur mongodb.com/atlas
2. Créer un **Database User** (nom + mot de passe)
3. **Network Access** : autoriser `0.0.0.0/0` (nécessaire car l'IP de Render change)
4. Récupérer la **connection string** : `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/gabriel?retryWrites=true&w=majority`

**`.env`** : ajout de `MONGODB_URI=<ta connection string>`. (Clé secrète, ne jamais committer — déjà couvert par le `.gitignore` existant qui ignore `.env`.)

**Nouveau fichier `db.js`** (sépare la persistance de server.js qui fait déjà 327 lignes) :
- Connecte un `MongoClient` singleton (pool réutilisé, connection établie au démarrage)
- Base `gabriel`, collection `journal_entries`
- Crée un index `{ user_id: 1, created_at: -1 }` pour les requêtes du journal
- Exporte : `addEntry({ userId, stepKey, content })`, `listEntries(userId)`, `deleteEntry(id, userId)`
- Schéma document :
  ```js
  { _id: ObjectId, user_id: String, step_key: String|null, content: String, created_at: Date }
  ```

> ✅ **Avantage clé** : contrairement à SQLite, **aucune donnée perdue** au redéploiement Render. Le journal privé de l'utilisateur survit aux restarts.

---

### Phase 2 — Nouvelle page `/discipulat` (roadmap + journal)

**Nouveau fichier `discipulat.html`** au style cohérent avec `privacy.html`/`terms.html` (max-width 900px, Arial, cartes `.box`, accents vert `#0b5` — DIFFÉRENT du vert WhatsApp de index.html).

Structure (tonalité **mentor bienveillant**, anti-gamification compétitive, conforme au texte fourni) :
1. **En-tête** : métaphore végétale en 4 stades — `Semence → Enracinement → Porteur de Fruit → Discipulateur`
2. **4 sections détaillées** (une par étape), chacune avec :
   - Contenu pédagogique (tiré de ton texte) :
     - **1. Nouvelle Naissance** (Carnet d'engagement) : engagement, baptême, pardon
     - **2. Enracinement** (Arbre de Prière & Journal d'Écoute) : Bible, prière, communion fraternelle
     - **3. Transformation** (Défis du Secret) : porter sa croix, vivre l'amour, gestion/générosité, sanctification
     - **4. Mission** (Mode Mentor) : partager l'Évangile, faire des disciples, servir
   - Une phrase-mentor (ex. *"Les bontés de Dieu se renouvellent chaque matin..."*) — **jamais** de points/XP/classement
   - Un mini-formulaire de journalisation lié à l'étape (textarea + bouton "Déposer")
3. **Section "Journal privé" centralisée** : liste chronologique de toutes les entrées + suppression

**Logique JS côté client** :
- Au 1er chargement, génère un `userId` (UUID) en `localStorage` — identité privée du journal
- `GET /api/journal?userId=...` (charger), `POST /api/journal { userId, stepKey, content }` (créer), `DELETE /api/journal/:id?userId=...` (supprimer, avec vérif d'appartenance serveur)

**Routes backend** dans `server.js` : `GET /discipulat` + `GET/POST/DELETE /api/journal`.

**Lien d'accès** depuis `index.html` (à côté des liens Politique/Conditions).

---

### Phase 3 — Exclusion de contacts (liste cochable avant envoi)

Actuellement les contacts sont lus **uniquement côté serveur** dans la boucle d'envoi, jamais envoyés au frontend. Nouvel endpoint + refonte du flux UX.

**Nouveau endpoint `GET /contacts`** dans `server.js` :
- Vérifie Google authentifié (sinon 401)
- Boucle paginée sur `people.connections.list` (jusqu'à `MAX_CONTACTS`) — **même logique que `envoyerMessagesParPages`** mais sans envoyer
- Retourne `{ contacts: [{ id, nom, numero }], total }` (`id` = `resourceName` Google)

**Modification `/start-broadcast`** : GET → **POST**, accepte `{ msgIdx, excludedIds: [...] }`.

**Modification `envoyerMessagesParPages(messageBase)`** → `envoyerMessagesParPages(messageBase, excludedIds)` :
- Construit un `Set` d'IDs exclus
- Dans la boucle `for (const person...)`, `continue` si `person.resourceName` est dans le Set

**Nouveau flux frontend (refonte de `lancerSync()`)** :
1. Récupère le `msgIdx` coché → ouvre fenêtre `/auth?msgIdx=...` (inchangé)
2. Sur `GOOGLE_AUTH_SUCCESS` : **fetch `/contacts`** → affiche une **modale liste cochable** (tous cochés par défaut, compteur "X contacts sélectionnés")
3. L'utilisateur décoche les contacts à exclure
4. Bouton "Confirmer et envoyer à X contacts" → **POST `/start-broadcast`** avec `{ msgIdx, excludedIds }`
5. Progression/fin via Socket.IO (inchangé)

---

### Phase 4 — Vérification & durcissement de la sélection de verset

**Analyse** : la sélection est **fonctionnellement correcte** — `rechercherVerset()` → `GET /search-bible` → API.Bible → bouton "Utiliser ce verset" → `POST /add-message` → recharge + sélectionne le radio ✅, et `lancerSync()` transmet bien le `msgIdx` jusqu'à l'envoi ✅.

**Bug à corriger** (XSS + cassure HTML) : dans `chargerMessages()`, `${msg}` est injecté tel quel dans `innerHTML`. Un verset contenant `<`, `>`, `"` ou `'` casse l'affichage et ouvre une faille XSS. **Correction** : fonction `escapeHtml()`.

---

### Phase 5 — Corrections bonus (au passage)

1. **Bug métadonnées** : `privacy.html:10` et `terms.html:10` référencent `/images/img_pub.jpg` mais le fichier est `img_pub.png` (oubli du commit `ef1a889`). → corriger.
2. **`.gitignore`** : ajouter `baileys_auth_info/` (credentials WhatsApp actuellement versionnés par erreur) et `data/`.

> Nettoyage des dépendances inutilisées (`multer`, `csv-parser`, `twilio`) volontairement hors périmètre pour ne pas grossir le diff.

---

### Résumé des fichiers touchés
| Fichier | Action |
|---|---|
| `package.json` | + `mongodb` |
| `db.js` | **nouveau** (connexion Atlas + requêtes journal) |
| `server.js` | require db, routes journal, `GET /contacts`, `/start-broadcast` → POST + exclusions, route `/discipulat` |
| `discipulat.html` | **nouveau** (roadmap 4 étapes + journal privé, tonalité mentor) |
| `index.html` | flux contacts cochable, lien `/discipulat`, `escapeHtml()` |
| `privacy.html`, `terms.html` | fix `img_pub.png` |
| `.gitignore` | + `data/`, `baileys_auth_info/` |
| `.env` | + `MONGODB_URI` (toi uniquement) |

### Ordre d'exécution
Phase 1 (MongoDB Atlas + db.js) → Phase 4 (fix XSS versets, indépendant) → Phase 2 (page discipulat) → Phase 3 (exclusion contacts) → Phase 5 (bonus). Test final : `node server.js` + vérification manuelle du flux.

### ⚠️ Prérequis de ton côté
Avant la Phase 1, je te demanderai la valeur de `MONGODB_URI` (ou de la saisir toi-même dans `.env`). Je te guiderai pas à pas pour créer le cluster Atlas gratuit si besoin.