import express from "express";
import cors from "cors";
import {
  fixturesToday,
  fixturesLive,
  headToHead,
  teamForm,
  searchTeams,
  budgetStatus,
  activeProvider,
} from "./src/provider.js";
import {
  lastFiveYears,
  h2hScore,
  formScore,
  preMatchModel,
  liveModel,
  teamAttackRate,
  correctScoreModel,
  evaluateMarket,
  evaluateCorrectScore,
} from "./src/predictor.js";

const app = express();
app.use(cors()); // allow the GitHub Pages frontend
app.use(express.json());

// Curated league metadata — used to give Today's Games nice names/continent
// grouping. Live Scores and Live Predictions do NOT filter by this list
// (see below), so any club in any competition API-Football covers will show.
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
  88: { name: "Eredivisie", country: "Netherlands", continent: "Europe" },
  94: { name: "Primeira Liga", country: "Portugal", continent: "Europe" },
  40: { name: "Championship", country: "England", continent: "Europe" },
  1: { name: "World Cup", country: "International", continent: "Europe" },
  4: { name: "Euro Championship", country: "International", continent: "Europe" },
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
  res.json({ ok: true, provider: activeProvider(), budget: budgetStatus() });
});

/** MENU 1 — Today's games, grouped by continent/country (curated list). */
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
    const { data, provider } = await searchTeams(q);
    res.json({ provider, teams: data.map((t) => ({ id: t.team.id, name: t.team.name, logo: t.team.logo, country: t.team.country })) });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/** MENU 2 — Stats: H2H analysis + prediction for two team IDs. */
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
 * Shared daily fixture scan — analyses each fixture ONCE per day and caches
 * every market's probability. Both Top Predictions (>=70%) and Daily Bomb
 * (long-shots) read from this same cache, so adding Daily Bomb costs zero
 * extra API requests.
 */
let dailyScanCache = { date: null, results: [] };

async function ensureDailyScan(limit) {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyScanCache.date === today && dailyScanCache.results.length > 0) {
    return { results: dailyScanCache.results, fromCache: true };
  }

  const { data } = await fixturesToday();
  const majors = data.filter(isMajor).filter((f) => f.fixture.status.short === "NS");
  const results = [];

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
      const h2h = h2hScore(meetings, homeId, awayId);
      const model = preMatchModel({
        h2h,
        homeForm: formScore(hForm, homeId),
        awayForm: formScore(aForm, awayId),
      });
      const correctScore = correctScoreModel({
        h2h,
        homeAttack: teamAttackRate(hForm, homeId),
        awayAttack: teamAttackRate(aForm, awayId),
      });
      results.push({
        fixtureId: f.fixture.id,
        match: `${f.teams.home.name} vs ${f.teams.away.name}`,
        league: f.league.name,
        kickoff: f.fixture.date,
        homeName: f.teams.home.name,
        awayName: f.teams.away.name,
        markets: model.markets,
        correctScore,
      });
    } catch { /* skip fixture on budget/throttle */ }
  }

  dailyScanCache = { date: today, results };
  return { results, fromCache: false };
}

/** Maps today's fixtures by ID so predictions can be graded against real
 *  results — reuses the same cached fixturesToday() call, no extra cost. */
async function todayFixtureMap() {
  const { data } = await fixturesToday();
  const map = new Map();
  for (const f of data) map.set(f.fixture.id, f);
  return map;
}

/** Grades one pick (by market key) against today's fixture map. Returns
 *  null (pending) until the match is confirmed full-time. */
function gradePick(fixtureMap, fixtureId, key) {
  const f = fixtureMap.get(fixtureId);
  if (!f || f.fixture.status.short !== "FT") return { result: null, finalScore: null };
  const hg = f.goals.home, ag = f.goals.away;
  return { result: evaluateMarket(key, hg, ag) ? "correct" : "wrong", finalScore: `${hg}-${ag}` };
}

/**
 * MENU 3 — Top predictions of the day (≥70% only). Reads the shared scan.
 */
app.get("/api/top-predictions", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 8), 12);
    const { results, fromCache } = await ensureDailyScan(limit);
    const fixtureMap = await todayFixtureMap();

    const picks = [];
    for (const r of results) {
      for (const mk of r.markets) {
        if (mk.p >= 70) {
          const { result, finalScore } = gradePick(fixtureMap, r.fixtureId, mk.key);
          picks.push({
            fixtureId: r.fixtureId,
            match: r.match,
            league: r.league,
            kickoff: r.kickoff,
            market: mk.name.replace("Home", r.homeName).replace("Away", r.awayName),
            p: mk.p,
            result,      // "correct" | "wrong" | null (not finished yet)
            finalScore,  // e.g. "2-1", or null if pending
          });
        }
      }
    }
    picks.sort((a, b) => b.p - a.p);
    res.json({ fromCache, picks });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/**
 * MENU 6 — Daily Bomb: the model's boldest long-shot picks of the day.
 * Deliberately LOW probability (8–42%) but backed by real signal (at least
 * 3 qualifying meetings) rather than pure noise. "Implied odds" here are a
 * model estimate (100/probability), NOT real bookmaker odds — we don't have
 * an odds feed. Reuses the same daily scan as Top Predictions, so it's free.
 */
app.get("/api/daily-bomb", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 8), 12);
    const { results, fromCache } = await ensureDailyScan(limit);
    const fixtureMap = await todayFixtureMap();

    const candidates = [];
    for (const r of results) {
      for (const mk of r.markets) {
        if (mk.p >= 8 && mk.p <= 42) {
          const { result, finalScore } = gradePick(fixtureMap, r.fixtureId, mk.key);
          candidates.push({
            fixtureId: r.fixtureId,
            match: r.match,
            league: r.league,
            kickoff: r.kickoff,
            market: mk.name.replace("Home", r.homeName).replace("Away", r.awayName),
            p: mk.p,
            impliedOdds: Math.round((100 / mk.p) * 100) / 100,
            result,
            finalScore,
          });
        }
      }
    }
    candidates.sort((a, b) => a.p - b.p); // rarest signal first — the boldest bomb
    res.json({ fromCache, bombs: candidates.slice(0, 3) });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/**
 * MENU 7 — Correct Score: the model's most likely exact scoreline per
 * fixture, via a Poisson goal model (blends H2H-specific scoring, oriented
 * to home/away, with each team's general recent attacking rate). Ranked by
 * "confidence gap" — how much clearer the #1 pick is over the #2 pick —
 * NOT by raw probability, since even the best single scoreline in football
 * is usually only 10-30% likely. That's normal for this market, not a bug.
 */
app.get("/api/correct-score", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 8), 12);
    const { results, fromCache } = await ensureDailyScan(limit);
    const fixtureMap = await todayFixtureMap();

    const picks = results
      .filter((r) => r.correctScore)
      .map((r) => {
        const f = fixtureMap.get(r.fixtureId);
        let result = null, finalScore = null;
        if (f && f.fixture.status.short === "FT") {
          finalScore = `${f.goals.home}-${f.goals.away}`;
          result = evaluateCorrectScore(r.correctScore.top.score, f.goals.home, f.goals.away) ? "correct" : "wrong";
        }
        return {
          fixtureId: r.fixtureId,
          match: r.match,
          league: r.league,
          kickoff: r.kickoff,
          score: r.correctScore.top.score,
          p: r.correctScore.top.p,
          runnerUp: r.correctScore.second,
          confidenceGap: r.correctScore.confidenceGap,
          result,
          finalScore,
        };
      })
      .sort((a, b) => b.confidenceGap - a.confidenceGap);

    res.json({ fromCache, picks });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/** MENU 4 — Live scores. Unfiltered — shows every live match API-Football
 *  covers, not just the curated major-league list, so smaller clubs and
 *  competitions (e.g. PSV in the Eredivisie, cup ties, etc.) show up too. */
app.get("/api/live", async (_req, res) => {
  try {
    const { data, fromCache } = await fixturesLive();
    res.json({ fromCache, matches: data.map(slimFixture) });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

/**
 * MENU 5 — Live predictions (after 25', ≥70% only). Also unfiltered.
 * Finished matches drop out of the live feed entirely, so a lightweight
 * in-memory log remembers today's live picks and grades them once their
 * fixture is confirmed full-time — this is what "history" below shows.
 * Resets on server restart/redeploy (no database), which is an acceptable
 * trade-off for a same-day, personal-scale feature.
 */
let livePredictionLog = [];
const LIVE_LOG_MAX = 40;

function logLivePrediction(fixture, pred) {
  const existing = livePredictionLog.find(
    (e) => e.fixtureId === fixture.fixture.id && e.key === pred.key
  );
  if (existing) { existing.p = pred.p; return; }
  livePredictionLog.push({
    fixtureId: fixture.fixture.id,
    match: `${fixture.teams.home.name} vs ${fixture.teams.away.name}`,
    market: pred.market,
    key: pred.key,
    p: pred.p,
    graded: false,
    result: null,
    finalScore: null,
  });
  if (livePredictionLog.length > LIVE_LOG_MAX) livePredictionLog.shift();
}

async function gradeLiveLog() {
  const pending = livePredictionLog.filter((e) => !e.graded);
  if (pending.length === 0) return;
  const fixtureMap = await todayFixtureMap();
  for (const e of pending) {
    const { result, finalScore } = gradePick(fixtureMap, e.fixtureId, e.key);
    if (result) { e.graded = true; e.result = result; e.finalScore = finalScore; }
  }
}

app.get("/api/live-predictions", async (_req, res) => {
  try {
    const { data, fromCache } = await fixturesLive();
    const results = [];
    for (const f of data) {
      const preds = liveModel(f);
      if (preds.length > 0) {
        results.push({ fixture: slimFixture(f), predictions: preds });
        preds.forEach((pred) => logLivePrediction(f, pred));
      }
    }
    await gradeLiveLog();
    const history = livePredictionLog.filter((e) => e.graded).slice(-10).reverse();
    res.json({ fromCache, results, history });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FSH Predict backend on :${PORT}`));
