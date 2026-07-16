/**
 * API-Football client with:
 *  - in-memory cache (TTL per data type)
 *  - daily request budget guard (free tier = 100/day)
 *  - per-minute throttle (free tier = 10/min)
 */

const BASE = "https://v3.football.api-sports.io";
const KEY = process.env.APIFOOTBALL_KEY;

// ---- Request budget ----
const DAILY_BUDGET = Number(process.env.DAILY_BUDGET || 95); // keep 5 in reserve
let usedToday = 0;
let budgetDate = new Date().toISOString().slice(0, 10);

// per-minute throttle
let minuteWindow = [];

function resetBudgetIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDate) {
    budgetDate = today;
    usedToday = 0;
  }
}

export function budgetStatus() {
  resetBudgetIfNewDay();
  return { used: usedToday, budget: DAILY_BUDGET, remaining: DAILY_BUDGET - usedToday };
}

// ---- Cache ----
const cache = new Map(); // key -> { expires, data }

function getCache(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  cache.delete(key);
  return null;
}

function setCache(key, data, ttlMs) {
  cache.set(key, { expires: Date.now() + ttlMs, data });
}

// TTLs — the free tier survives on these
export const TTL = {
  FIXTURES_TODAY: 60 * 60 * 1000,      // 1h  (kickoff times don't move)
  LIVE: 90 * 1000,                     // 90s (live polling)
  H2H: 7 * 24 * 60 * 60 * 1000,        // 7d  (history barely changes)
  TEAM_FORM: 12 * 60 * 60 * 1000,      // 12h
  STANDINGS: 24 * 60 * 60 * 1000,      // 24h
  ODDS: 3 * 60 * 60 * 1000,            // 3h
};

async function rawFetch(path) {
  resetBudgetIfNewDay();

  if (usedToday >= DAILY_BUDGET) {
    const err = new Error("Daily API budget exhausted — serving cache only");
    err.code = "BUDGET";
    throw err;
  }

  // per-minute throttle (free tier: 10/min → we cap at 8)
  const now = Date.now();
  minuteWindow = minuteWindow.filter((t) => now - t < 60_000);
  if (minuteWindow.length >= 8) {
    const err = new Error("Per-minute rate guard hit — retry shortly");
    err.code = "THROTTLE";
    throw err;
  }
  minuteWindow.push(now);

  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": KEY },
  });
  usedToday += 1;

  if (!res.ok) throw new Error(`API-Football ${res.status} on ${path}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error(`API-Football error: ${JSON.stringify(json.errors)}`);
  }
  return json.response;
}

/**
 * Cached fetch. On budget/throttle errors, serves stale cache if present.
 */
export async function apiGet(path, ttl) {
  const cached = getCache(path);
  if (cached) return { data: cached, fromCache: true };

  try {
    const data = await rawFetch(path);
    setCache(path, data, ttl);
    return { data, fromCache: false };
  } catch (e) {
    // last resort: expired cache is better than nothing
    const stale = cache.get(path);
    if (stale) return { data: stale.data, fromCache: true, stale: true };
    throw e;
  }
}

// ---- Convenience wrappers ----

export const todayStr = () => new Date().toISOString().slice(0, 10);

/** ALL of today's fixtures worldwide — a single request. */
export async function fixturesToday() {
  return apiGet(`/fixtures?date=${todayStr()}`, TTL.FIXTURES_TODAY);
}

/** All live matches — a single request. */
export async function fixturesLive() {
  return apiGet(`/fixtures?live=all`, TTL.LIVE);
}

/** Head-to-head, last N meetings between two team IDs. */
export async function headToHead(teamA, teamB, last = 20) {
  return apiGet(`/fixtures/headtohead?h2h=${teamA}-${teamB}&last=${last}`, TTL.H2H);
}

/** A team's last N fixtures (form). */
export async function teamForm(teamId, last = 10) {
  return apiGet(`/fixtures?team=${teamId}&last=${last}`, TTL.TEAM_FORM);
}

/** Search teams by name (for the Stats menu selectors). */
export async function searchTeams(name) {
  return apiGet(`/teams?search=${encodeURIComponent(name)}`, TTL.H2H);
}
