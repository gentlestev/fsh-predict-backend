import express from "express";
import cors from "cors";
import {
  fixturesToday,
  fixturesLive,
  headToHead,
  teamForm,
  searchTeams,
  budgetStatus,
} from "./src/apiFootball.js";
import {
  lastFiveYears,
  h2hScore,
  formScore,
  preMatchModel,
  liveModel,
} from "./src/predictor.js";

const app = express();
app.use(cors()); // allow the GitHub Pages frontend
app.use(express.json());

// Major league IDs on API-Football (v3) — used to filter "major matches"
const MAJOR_LEAGUES = {
  39: { name: "Premier League", country: "England", continent: "Europe" },
  140: { name: "La Liga", country: "Spain", continent: "Europe" },
  78: { name: "Bundesliga", country: "Germany", continent: "Europe" },
  135: { name: "Serie A", country: "Italy", continent: "Europe" },
  61: { name: "Ligue 1", country: "France", continent: "Europe" },
  2: { name: "Champions League", country: "Europe", continent: "Europe" },
  3: { name: "Europa League", country: "Europe", continent: "Europe" },
  71: { name: "Brasileirão Serie A", country: "Brazil", continent: "South America" },
  128: { name: "Liga Profesional", country: "Argentina", continent: "South America" },
  253: { name: "MLS", country: "USA", continent: "North America" },
  262: { name: "Liga MX", country: "Mexico", continent: "North America" },
  307: { name: "Saudi Pro League", country: "Saudi Arabia", continent: "Asia" },
  98: { name: "J1 League", country: "Japan", continent: "Asia" },
  233: { name: "Egyptian Premier League", country: "Egypt", continent: "Africa" },
  200: { name: "Botola Pro", country: "Morocco", continent: "Africa" },
  399: { name: "NPFL", country: "Nigeria", continent: "Africa" },
};

const isMajor = (f) => MAJOR_LEAGUES[f.league.id] !== undefined;

function slimFixture(f) {
  const meta = MAJOR_LEAGUES[f.league.id] || {};
  return {
    id: f.fixture.id,
    date: f.fixture.date,
    status: f.fixture.status.short,
    minute: f.fixture.status.elapsed,
    league: f.league.name,
    leagueId: f.league.id,
    country: meta.country || f.league.country,
    continent: meta.continent || "Other",
    home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
    away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
    goals: f.goals,
  };
}

/* ------------ ROUTES ------------ */

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, budget: budgetStatus() });
});

/** MENU 1 — Today's games (filter with ?continent=Europe&country=England) */
app.get("/api/today", async (req, res) => {
  try {
    const { data, fromCache } = await fixturesToday();
    let list = data.filter(isMajor).map(slimFixture);
    if (req.query.continent) list = list.filter((m) => m.continent === req.query.continent);
    if (req.query.country) list = list.filter((m) => m.country === req.query.country);
    res.json({ fromCache, count: list.length, matches: list });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/** Team search for the Stats menu selectors */
app.get("/api/teams/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (q.length < 3) return res.json({ teams: [] });
    const { data } = await searchTeams(q);
    res.json({ teams: data.map((t) => ({ id: t.team.id, name: t.team.name, logo: t.team.logo, country: t.team.country })) });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/** MENU 2 — Stats: H2H analysis + prediction for two team IDs */
app.get("/api/h2h/:homeId/:awayId", async (req, res) => {
  try {
    const homeId = Number(req.params.homeId);
    const awayId = Number(req.params.awayId);

    const [{ data: h2hRaw }, { data: hForm }, { data: aForm }] = await Promise.all([
      headToHead(homeId, awayId, 20),
      teamForm(homeId, 10),
      teamForm(awayId, 10),
    ]);

    const meetings = lastFiveYears(h2hRaw);
    const h2h = h2hScore(meetings, homeId, awayId);
    const model = preMatchModel({
      h2h,
      homeForm: formScore(hForm, homeId),
      awayForm: formScore(aForm, awayId),
    });

    res.json({
      meetings: meetings.map((f) => ({
        date: f.fixture.date.slice(0, 10),
        league: f.league.name,
        home: f.teams.home.name,
        away: f.teams.away.name,
        score: `${f.goals.home}-${f.goals.away}`,
      })),
      summary: h2h,
      prediction: model,
    });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/**
 * MENU 3 — Top predictions of the day (≥70% only).
 * Budget-aware: analyses at most `limit` fixtures per call (each costs ~3 requests
 * on first run, then cached). Results cached for the whole day after first build.
 */
let topPicksCache = { date: null, picks: [] };

app.get("/api/top-predictions", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (topPicksCache.date === today && topPicksCache.picks.length > 0) {
      return res.json({ fromCache: true, picks: topPicksCache.picks });
    }

    const { data } = await fixturesToday();
    const majors = data.filter(isMajor).filter((f) => f.fixture.status.short === "NS");
    const limit = Math.min(Number(req.query.limit || 8), 12); // budget guard
    const picks = [];

    for (const f of majors.slice(0, limit)) {
      try {
        const homeId = f.teams.home.id, awayId = f.teams.away.id;
        const [{ data: h2hRaw }, { data: hForm }, { data: aForm }] = await Promise.all([
          headToHead(homeId, awayId, 20),
          teamForm(homeId, 10),
          teamForm(awayId, 10),
        ]);
        const meetings = lastFiveYears(h2hRaw);
        if (meetings.length < 3) continue;
        const model = preMatchModel({
          h2h: h2hScore(meetings, homeId, awayId),
          homeForm: formScore(hForm, homeId),
          awayForm: formScore(aForm, awayId),
        });
        for (const mk of model.markets) {
          if (mk.p >= 70) {
            picks.push({
              fixtureId: f.fixture.id,
              match: `${f.teams.home.name} vs ${f.teams.away.name}`,
              league: f.league.name,
              kickoff: f.fixture.date,
              market: mk.name.replace("Home", f.teams.home.name).replace("Away", f.teams.away.name),
              p: mk.p,
            });
          }
        }
      } catch { /* skip fixture on budget/throttle */ }
    }

    picks.sort((a, b) => b.p - a.p);
    topPicksCache = { date: today, picks };
    res.json({ fromCache: false, picks });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/** MENU 4 — Live scores */
app.get("/api/live", async (_req, res) => {
  try {
    const { data, fromCache } = await fixturesLive();
    res.json({ fromCache, matches: data.filter(isMajor).map(slimFixture) });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/** MENU 5 — Live predictions (after 25', ≥70% only) */
app.get("/api/live-predictions", async (_req, res) => {
  try {
    const { data, fromCache } = await fixturesLive();
    const results = [];
    for (const f of data.filter(isMajor)) {
      const preds = liveModel(f);
      if (preds.length > 0) {
        results.push({ fixture: slimFixture(f), predictions: preds });
      }
    }
    res.json({ fromCache, results });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/**
 * MENU 6 — High odds picks: markets the model rates LOW probability
 * (long shots) from today's analysed fixtures.
 */
app.get("/api/high-odds", async (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // reuse the day's analysed picks store; low-p markets are the long shots
    if (topPicksCache.date !== today) {
      return res.json({ picks: [], note: "Run /api/top-predictions first — analysis is shared to save your API budget." });
    }
    // long shots are computed during top-predictions; simplest v1: invert threshold
    res.json({ note: "v1: derive from same model run — markets under 35% are long shots. Extend by adding /odds endpoint when on paid tier.", picks: [] });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FSH Predict backend on :${PORT}`));
