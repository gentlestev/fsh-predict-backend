/**
 * football-data.org (v4) fallback client.
 * Free tier: 12 competitions, 10 req/min, delayed scores, mostly current-season history.
 *
 * Everything returned here is NORMALISED to API-Football's response shape,
 * so the predictor and routes work unchanged regardless of provider.
 */

const BASE = "https://api.football-data.org/v4";
const KEY = process.env.FOOTBALLDATA_KEY;

// FD competition code -> pseudo API-Football league id used by server.js MAJOR_LEAGUES
export const FD_LEAGUE_MAP = {
  PL:  { id: 39,  name: "Premier League" },
  PD:  { id: 140, name: "La Liga" },
  BL1: { id: 78,  name: "Bundesliga" },
  SA:  { id: 135, name: "Serie A" },
  FL1: { id: 61,  name: "Ligue 1" },
  CL:  { id: 2,   name: "Champions League" },
  DED: { id: 88,  name: "Eredivisie" },
  PPL: { id: 94,  name: "Primeira Liga" },
  ELC: { id: 40,  name: "Championship" },
  BSA: { id: 71,  name: "Brasileirão Serie A" },
  WC:  { id: 1,   name: "World Cup" },
  EC:  { id: 4,   name: "Euro Championship" },
};

// ---- throttle (10/min free) + cache ----
let minuteWindow = [];
const cache = new Map();

function getCache(k){ const h = cache.get(k); if (h && h.expires > Date.now()) return h.data; cache.delete(k); return null; }
function setCache(k, d, ttl){ cache.set(k, { expires: Date.now() + ttl, data: d }); }

async function fdFetch(path, ttl) {
  const cached = getCache(path);
  if (cached) return { data: cached, fromCache: true };

  const now = Date.now();
  minuteWindow = minuteWindow.filter((t) => now - t < 60_000);
  if (minuteWindow.length >= 8) {
    const stale = cache.get(path);
    if (stale) return { data: stale.data, fromCache: true, stale: true };
    const err = new Error("football-data.org rate guard hit — retry shortly");
    err.code = "THROTTLE";
    throw err;
  }
  minuteWindow.push(now);

  const res = await fetch(`${BASE}${path}`, { headers: { "X-Auth-Token": KEY } });
  if (!res.ok) {
    const stale = cache.get(path);
    if (stale) return { data: stale.data, fromCache: true, stale: true };
    throw new Error(`football-data.org ${res.status} on ${path}`);
  }
  const json = await res.json();
  setCache(path, json, ttl);
  return { data: json, fromCache: false };
}

// ---- status + minute normalisation ----
function mapStatus(fdStatus) {
  switch (fdStatus) {
    case "SCHEDULED": case "TIMED": return "NS";
    case "IN_PLAY": return "1H";       // FD doesn't expose the half on free
    case "PAUSED": return "HT";
    case "FINISHED": return "FT";
    case "POSTPONED": return "PST";
    case "SUSPENDED": return "SUSP";
    case "CANCELLED": return "CANC";
    default: return fdStatus;
  }
}

/** Estimate elapsed minutes from kickoff (FD free tier doesn't send minute). */
function estimateElapsed(match) {
  if (match.minute && !isNaN(match.minute)) return Number(match.minute);
  if (!["IN_PLAY", "PAUSED"].includes(match.status)) return null;
  const mins = Math.floor((Date.now() - new Date(match.utcDate).getTime()) / 60000);
  // rough correction for halftime break after ~60 wall-clock minutes
  const est = mins > 60 ? mins - 15 : mins;
  return Math.max(1, Math.min(est, 90));
}

/** Normalise one FD match into API-Football fixture shape. */
function toAFShape(m) {
  const lg = FD_LEAGUE_MAP[m.competition?.code] || { id: m.competition?.id ?? 0, name: m.competition?.name ?? "Unknown" };
  return {
    fixture: {
      id: m.id,
      date: m.utcDate,
      status: { short: mapStatus(m.status), elapsed: estimateElapsed(m) },
    },
    league: { id: lg.id, name: lg.name, country: m.area?.name || "" },
    teams: {
      home: { id: m.homeTeam?.id, name: m.homeTeam?.shortName || m.homeTeam?.name, logo: m.homeTeam?.crest || "" },
      away: { id: m.awayTeam?.id, name: m.awayTeam?.shortName || m.awayTeam?.name, logo: m.awayTeam?.crest || "" },
    },
    goals: { home: m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? null,
             away: m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? null },
  };
}

const TTL = {
  TODAY: 60 * 60 * 1000,
  LIVE: 2 * 60 * 1000,       // scores are delayed on free anyway
  TEAMS: 24 * 60 * 60 * 1000,
  MATCHES: 6 * 60 * 60 * 1000,
};

const todayStr = () => new Date().toISOString().slice(0, 10);

export async function fdFixturesToday() {
  const d = todayStr();
  const { data, fromCache } = await fdFetch(`/matches?dateFrom=${d}&dateTo=${d}`, TTL.TODAY);
  return { data: (data.matches || []).map(toAFShape), fromCache };
}

export async function fdFixturesLive() {
  const d = todayStr();
  const { data, fromCache } = await fdFetch(`/matches?dateFrom=${d}&dateTo=${d}`, TTL.LIVE);
  const live = (data.matches || []).filter((m) => ["IN_PLAY", "PAUSED"].includes(m.status));
  return { data: live.map(toAFShape), fromCache };
}

/** Team search: pull squads of the big-5 comps once/day, filter locally. */
const SEARCH_COMPS = ["PL", "PD", "BL1", "SA", "FL1"];
export async function fdSearchTeams(q) {
  const all = [];
  for (const c of SEARCH_COMPS) {
    try {
      const { data } = await fdFetch(`/competitions/${c}/teams`, TTL.TEAMS);
      for (const t of data.teams || []) {
        all.push({ team: { id: t.id, name: t.shortName || t.name, logo: t.crest, country: data.area?.name } });
      }
    } catch { /* skip comp on throttle */ }
  }
  const needle = q.toLowerCase();
  const seen = new Set();
  return {
    data: all.filter((t) => {
      if (seen.has(t.team.id)) return false;
      seen.add(t.team.id);
      return t.team.name.toLowerCase().includes(needle);
    }),
    fromCache: true,
  };
}

/** A team's finished matches (used for both form and H2H filtering). */
export async function fdTeamMatches(teamId, limit = 100) {
  const { data, fromCache } = await fdFetch(`/teams/${teamId}/matches?status=FINISHED&limit=${limit}`, TTL.MATCHES);
  return { data: (data.matches || []).map(toAFShape), fromCache };
}

/** H2H: intersect one team's match history with the opponent. */
export async function fdHeadToHead(teamA, teamB) {
  const { data } = await fdTeamMatches(teamA, 100);
  const meetings = data.filter(
    (f) => f.teams.home.id === teamB || f.teams.away.id === teamB
  );
  return { data: meetings, fromCache: true };
}

export async function fdTeamForm(teamId, last = 10) {
  const { data } = await fdTeamMatches(teamId, 50);
  // most recent first
  const sorted = [...data].sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  return { data: sorted.slice(0, last), fromCache: true };
}
