/**
 * API-Football client with:
 *  - in-memory cache (TTL per data type)
 *  - configurable daily budget guard (set DAILY_BUDGET env var to match your plan)
 *  - configurable per-minute throttle (set REQUESTS_PER_MINUTE to match your plan)
 */

const BASE = "https://v3.football.api-sports.io";
const KEY = process.env.APIFOOTBALL_KEY;

// ---- Request budget ----
const DAILY_BUDGET = Number(process.env.DAILY_BUDGET || 95);
const PER_MINUTE_CAP = Number(process.env.REQUESTS_PER_MINUTE || 8);
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

// TTLs
export const TTL = {
  FIXTURES_TODAY: 60 * 60 * 1000,      // 1h  (kickoff times don't move)
  LIVE: 90 * 1000,                     // 90s (live polling)
  H2H: 7 * 24 * 60 * 60 * 1000,        // 7d  (history barely changes)
  TEAM_FORM: 12 * 60 * 60 * 1000,      // 12h
  STANDINGS: 24 * 60 * 60 * 1000,      // 24h
  ODDS: 3 * 60 * 60 * 1000,            // 3h
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pendingReqs = new Map();

async function rawFetch(path) {
  resetBudgetIfNewDay();

  if (usedToday >= DAILY_BUDGET) {
    const err = new Error("Daily API budget exhausted — serving cache only");
    err.code = "BUDGET";
    throw err;
  }

  // per-minute throttle (free tier: 10/min → we cap at 8) — wait for a slot
  // instead of failing outright; a Stats analysis fires 3 requests at once,
  // so a brief queue here is normal, not an error.
  for (let tries = 0; tries < 4; tries++) {
    const now = Date.now();
    minuteWindow = minuteWindow.filter((t) => now - t < 60_000);
    if (minuteWindow.length < PER_MINUTE_CAP) break;
    const waitMs = Math.min(60_000 - (now - minuteWindow[0]) + 300, 20_000);
    await sleep(waitMs);
  }
  minuteWindow = minuteWindow.filter((t) => Date.now() - t < 60_000);
  if (minuteWindow.length >= PER_MINUTE_CAP) {
    const err = new Error("API-Football is busy — try again in a minute");
    err.code = "THROTTLE";
    throw err;
  }
  minuteWindow.push(Date.now());

  let res = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": KEY },
  });
  usedToday += 1;

  if (res.status === 429) {
    await sleep(15_000); // one polite retry if API-Football itself rate-limited us
    res = await fetch(`${BASE}${path}`, { headers: { "x-apisports-key": KEY } });
    usedToday += 1;
  }

  if (!res.ok) throw new Error(`API-Football ${res.status} on ${path}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error(`API-Football error: ${JSON.stringify(json.errors)}`);
  }
  return json.response;
}

/**
 * Cached fetch. On budget/throttle errors, serves stale cache if present.
 * Concurrent identical requests share one in-flight fetch instead of each
 * burning their own slot.
 */
export async function apiGet(path, ttl) {
  const cached = getCache(path);
  if (cached) return { data: cached, fromCache: true };

  if (pendingReqs.has(path)) {
    const data = await pendingReqs.get(path);
    return { data, fromCache: false };
  }

  const p = (async () => {
    try {
      const data = await rawFetch(path);
      setCache(path, data, ttl);
      return data;
    } finally {
      pendingReqs.delete(path);
    }
  })();
  pendingReqs.set(path, p);

  try {
    const data = await p;
    return { data, fromCache: false };
  } catch (e) {
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
