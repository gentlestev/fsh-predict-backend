# FSH Predict — Backend

Football prediction engine. Sits between the FSH Predict frontend (GitHub Pages) and API-Football, with caching and a daily request budget so it survives on the free tier (100 req/day).

## Endpoints

| Route | Menu | Notes |
|---|---|---|
| `GET /api/health` | — | shows remaining daily API budget |
| `GET /api/today?continent=Europe&country=England` | Today's Games | 1 API request/hour (cached) |
| `GET /api/teams/search?q=arsenal` | Stats | team ID lookup |
| `GET /api/h2h/:homeId/:awayId` | Stats | 5-yr H2H + form + prediction (~3 requests, cached 7 days) |
| `GET /api/top-predictions?limit=8` | Top Predictions | ≥70% picks; built once/day then cached |
| `GET /api/live` | Live Scores | cached 90s |
| `GET /api/live-predictions` | Live Predictions | after 25', ≥70% only |
| `GET /api/high-odds` | High Odds | v1 stub — full version needs the paid odds endpoint |

## Local setup

```bash
npm install
export APIFOOTBALL_KEY=your_key_here
npm start
# test:
curl http://localhost:3000/api/health
curl http://localhost:3000/api/today
```

Your key is in the API-Sports dashboard → Account → API Key. **Never put the key in frontend code or a public repo.**

## Deploy to Render (free)

1. Push this folder to a **new GitHub repo** (e.g. `fsh-predict-backend`)
2. render.com → New → **Web Service** → connect the repo
3. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
4. Environment → add variable: `APIFOOTBALL_KEY = your_key`
5. Deploy. Your API lives at `https://fsh-predict-backend.onrender.com`

**Free-tier note:** Render free instances sleep after 15 min idle; first request after sleep takes ~30–60s to wake. Fine for personal use.

## Budget math (free tier: 100/day)

- Today's fixtures: ~12 requests/day (1/hour, cached)
- Top predictions: ~24 requests once/day (8 fixtures × 3 calls, then cached)
- Live polling: 1 request / 90s **only while you have the app open**
- H2H lookups: ~3 each, cached 7 days

Doable for one user with the app open a few hours/day. When you want continuous live polling or more fixtures analysed, upgrade to API-Football Pro ($19/mo, 7,500/day) — no code changes needed, just raise `DAILY_BUDGET`.

## Next milestones

- [ ] Supabase table for storing daily picks + end-of-day GOOD/FAIL grading
- [ ] Cron (Render cron job or GitHub Action) to grade picks at midnight
- [ ] `/odds` integration for real bookmaker odds on High Odds menu (paid tier)
- [ ] Point the frontend at this API base URL
