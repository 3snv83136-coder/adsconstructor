# ⚡ AdWords Automator

**Gestion automatisée de campagnes Google Ads — minute par minute**

Application Node.js pour automatiser la gestion de campagnes Google Ads avec :

- 🛡️ **Bloqueur de clics abusifs** — Détection de fraude en temps réel (7 axes d'analyse)
- 📈 **Optimiseur ROI** — Ajustements automatiques des enchères et budgets
- 📅 **Calendrier de diffusion** — Planification précise à la minute
- 🔌 **Dashboard temps réel** — Monitoring via WebSocket

---

## Architecture

```
adwords-automator/
├── src/
│   ├── server.js                  # Point d'entrée Express + HTTP
│   ├── config.js                  # Configuration centralisée
│   ├── database.js                # SQLite (WAL, foreign keys)
│   ├── routes/
│   │   ├── campaigns.js           # API REST campagnes
│   │   ├── fraud.js               # API REST fraude
│   │   ├── roi.js                 # API REST ROI
│   │   └── calendar.js            # API REST calendrier
│   └── services/
│       ├── adsApiClient.js        # Client Google Ads API (OAuth2)
│       ├── fraudDetector.js       # Détecteur de fraude
│       ├── roiOptimizer.js        # Optimiseur ROI automatique
│       ├── calendarScheduler.js   # Planificateur de diffusion
│       └── realtimeMonitor.js     # WebSocket temps réel
├── public/
│   └── index.html                 # Dashboard frontend
├── data/                          # Base SQLite (auto-créée)
├── logs/                          # Logs applicatifs
├── .env.example                   # Configuration exemple
└── package.json
```

## Installation

```bash
cd adwords-automator

# Installer les dépendances
npm install

# Configurer l'environnement
cp .env.example .env
# Éditer .env avec vos credentials Google Ads
```

## Démarrage

```bash
# Mode développement (avec rechargement automatique)
npm run dev

# Mode production
npm start
```

Le serveur démarre sur `http://localhost:3000`.

**Sans credentials Google Ads**, l'application fonctionne en **mode simulation** — les métriques sont générées de façon réaliste. Idéal pour le développement et les tests.

## API REST

### Campagnes

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/campaigns` | Liste toutes les campagnes |
| POST | `/api/campaigns` | Crée une campagne |
| GET | `/api/campaigns/:id` | Détail d'une campagne |
| PUT | `/api/campaigns/:id` | Met à jour une campagne |
| POST | `/api/campaigns/:id/pause` | Met en pause |
| POST | `/api/campaigns/:id/resume` | Réactive |
| GET | `/api/campaigns/:id/metrics` | Métriques temps réel |
| GET | `/api/campaigns/:id/roi-analysis` | Analyse ROI complète |

### Fraude

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/fraud/analyze` | Analyse un clic |
| GET | `/api/fraud/stats` | Statistiques du détecteur |
| GET | `/api/fraud/blocked-ips` | IPs bloquées |
| POST | `/api/fraud/block-ip` | Bloquer une IP |
| POST | `/api/fraud/unblock/:ip` | Débloquer une IP |

### ROI

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/roi/status` | État global ROI |
| GET | `/api/roi/adjustments` | Historique des ajustements |
| POST | `/api/roi/optimize-now` | Lance un cycle d'optimisation |

### Calendrier

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/calendar/state` | État actuel du calendrier |
| POST | `/api/calendar/schedules` | Ajoute une plage de diffusion |
| GET | `/api/calendar/events` | Événements calendaires |
| POST | `/api/calendar/events` | Ajoute un événement |

## Exemples d'utilisation

### Créer une campagne

```bash
curl -X POST http://localhost:3000/api/campaigns \
  -H "Content-Type: application/json" \
  -d '{"name": "Campagne Printemps", "dailyBudget": 50, "maxCpc": 1.5}'
```

### Définir un planning de diffusion

```bash
curl -X POST http://localhost:3000/api/calendar/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "campaign_id": 1,
    "day_of_week": 1,
    "start_hour": 9,
    "start_minute": 0,
    "end_hour": 18,
    "end_minute": 0,
    "bid_adjustment": 1.2
  }'
```

### Ajouter un blackout

```bash
curl -X POST http://localhost:3000/api/calendar/events \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Férié 14 juillet",
    "type": "blackout",
    "start_date": "2026-07-14T00:00:00.000Z",
    "end_date": "2026-07-14T23:59:59.000Z"
  }'
```

### Simuler un clic (test fraude)

```bash
curl -X POST http://localhost:3000/api/fraud/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "ip_address": "192.168.1.100",
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "campaign_id": 1
  }'
```

## Bloqueur de clics — Fonctionnement

Le détecteur analyse chaque clic sur **7 axes** :

1. **Liste noire** — IP déjà bloquée → rejet immédiat
2. **Fréquence IP/minute** — Seuil configurable (défaut: 10/min)
3. **Vélocité** — Intervalle inter-clics < 200ms → suspect
4. **User-Agent** — Patterns bot/crawler/scraper → suspect
5. **Referrer** — Absent ou domaine suspect → suspect
6. **Géo-anomalie** — Changement de pays en < 10min → suspect
7. **Abus campagne** — Multi-clics même IP sur même campagne

Score cumulatif 0-100. Blocage automatique à partir de 70.

## Configuration

Toute la configuration est dans le fichier `.env`. Voir `.env.example` pour la liste complète.

## Licence

MIT
