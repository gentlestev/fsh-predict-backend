/**
 * Provider layer.
 * Tries API-Football first; on account/suspension errors it automatically
 * falls back to football-data.org for 6 hours, then retries API-Football.
 *
 * Force a provider with env DATA_PROVIDER=apifootball | footballdata
 */

import * as AF from "./apiFootball.js";
import {
  fdFixturesToday, fdFixturesLive, fdSearchTeams,
  fdHeadToHead, fdTeamForm,
} from "./footballData.js";

const FORCE = (process.env.DATA_PROVIDER || "").toLowerCase();
const RETRY_AF_AFTER_MS = 6 * 60 * 60 * 1000;

let afDownUntil = 0;

function afLooksDown(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("suspend") || msg.includes("subscription") ||
         msg.includes("not subscribed") || msg.includes("access") ||
         msg.includes("401") || msg.includes("403") || msg.includes("token");
}

export function activeProvider() {
  if (FORCE === "footballdata") return "footballdata";
  if (FORCE === "apifootball") return "apifootball";
  if (!process.env.APIFOOTBALL_KEY) return "footballdata";
  return Date.now() < afDownUntil ? "footballdata" : "apifootball";
}

async function withFallback(afFn, fdFn) {
  if (activeProvider() === "footballdata") {
    if (!process.env.FOOTBALLDATA_KEY) throw new Error("No FOOTBALLDATA_KEY set and API-Football unavailable");
    return { ...(await fdFn()), provider: "footballdata" };
  }
  try {
    return { ...(await afFn()), provider: "apifootball" };
  } catch (e) {
    if (afLooksDown(e) && process.env.FOOTBALLDATA_KEY) {
      afDownUntil = Date.now() + RETRY_AF_AFTER_MS;
      console.warn(`API-Football unavailable (${e.message}) — falling back to football-data.org for 6h`);
      return { ...(await fdFn()), provider: "footballdata" };
    }
    throw e;
  }
}

export const fixturesToday = () => withFallback(AF.fixturesToday, fdFixturesToday);
export const fixturesLive  = () => withFallback(AF.fixturesLive,  fdFixturesLive);
export const searchTeams   = (q) => withFallback(() => AF.searchTeams(q), () => fdSearchTeams(q));
export const headToHead    = (a, b, last = 20) =>
  withFallback(() => AF.headToHead(a, b, last), () => fdHeadToHead(a, b));
export const teamForm      = (id, last = 10) =>
  withFallback(() => AF.teamForm(id, last), () => fdTeamForm(id, last));

export const budgetStatus = AF.budgetStatus;
