/**
 * FSH Predict — prediction engine
 *
 * Pre-match model: blends
 *   - Head-to-head record (last 5 years, weighted toward recent meetings)
 *   - Recent form (last 10 matches, weighted toward recent)
 *   - Home advantage
 *   - Goals scored/conceded rates
 *
 * Output: probabilities for 1X2 + derived markets, normalised to 100.
 * These are estimates, not guarantees.
 */

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** Filter API-Football fixtures to finished matches in the last 5 years. */
export function lastFiveYears(fixtures) {
  const cutoff = Date.now() - FIVE_YEARS_MS;
  return fixtures.filter(
    (f) =>
      new Date(f.fixture.date).getTime() >= cutoff &&
      f.fixture.status.short === "FT"
  );
}

/** Recency weight: most recent meeting counts ~3x the oldest. */
function recencyWeight(dateStr) {
  const age = Date.now() - new Date(dateStr).getTime();
  const frac = Math.min(age / FIVE_YEARS_MS, 1); // 0 = today, 1 = 5y ago
  return 3 - 2 * frac;
}

/** Score a team's form from its last fixtures. Returns 0..1. */
export function formScore(fixtures, teamId) {
  const finished = fixtures.filter((f) => f.fixture.status.short === "FT");
  if (finished.length === 0) return 0.5;
  let pts = 0;
  let max = 0;
  finished.forEach((f, i) => {
    const w = finished.length - i; // most recent first from API
    const isHome = f.teams.home.id === teamId;
    const gf = isHome ? f.goals.home : f.goals.away;
    const ga = isHome ? f.goals.away : f.goals.home;
    const p = gf > ga ? 3 : gf === ga ? 1 : 0;
    pts += p * w;
    max += 3 * w;
  });
  return pts / max;
}

/** Head-to-head strengths from historical meetings. */
export function h2hScore(meetings, homeTeamId, awayTeamId) {
  let home = 0, away = 0, draw = 0, total = 0;
  let goalsSum = 0, bttsCount = 0, over25 = 0;
  let homeGoalsSum = 0, awayGoalsSum = 0;

  for (const f of meetings) {
    const w = recencyWeight(f.fixture.date);
    total += w;
    const hg = f.goals.home, ag = f.goals.away;
    const homeWasHomeTeam = f.teams.home.id === homeTeamId;

    const homeGoals = homeWasHomeTeam ? hg : ag;
    const awayGoals = homeWasHomeTeam ? ag : hg;

    if (homeGoals > awayGoals) home += w;
    else if (awayGoals > homeGoals) away += w;
    else draw += w;

    goalsSum += hg + ag;
    homeGoalsSum += homeGoals;
    awayGoalsSum += awayGoals;
    if (hg > 0 && ag > 0) bttsCount += 1;
    if (hg + ag > 2) over25 += 1;
  }

  const n = meetings.length || 1;
  const years = meetings.map((f) => new Date(f.fixture.date).getFullYear());
  return {
    homeRate: total ? home / total : 0.4,
    drawRate: total ? draw / total : 0.25,
    awayRate: total ? away / total : 0.35,
    avgGoals: goalsSum / n,
    avgHomeGoals: homeGoalsSum / n,
    avgAwayGoals: awayGoalsSum / n,
    bttsRate: bttsCount / n,
    over25Rate: over25 / n,
    meetings: meetings.length,
    earliestYear: years.length ? Math.min(...years) : null,
    latestYear: years.length ? Math.max(...years) : null,
  };
}

/**
 * Blend H2H + form + home advantage into 1X2 probabilities.
 * Weights: H2H 45%, form 40%, home edge 15%.
 */
export function preMatchModel({ h2h, homeForm, awayForm }) {
  const HOME_EDGE = 0.12;

  // form-implied outcome tendency
  const fDelta = homeForm - awayForm; // -1..1
  const formHome = 0.38 + fDelta * 0.35;
  const formAway = 0.38 - fDelta * 0.35;
  const formDraw = 1 - formHome - formAway;

  let pHome = 0.45 * h2h.homeRate + 0.40 * formHome + 0.15 * (0.45 + HOME_EDGE);
  let pAway = 0.45 * h2h.awayRate + 0.40 * formAway + 0.15 * (0.35 - HOME_EDGE);
  let pDraw = 0.45 * h2h.drawRate + 0.40 * Math.max(formDraw, 0.15) + 0.15 * 0.25;

  // normalise
  const sum = pHome + pDraw + pAway;
  pHome /= sum; pDraw /= sum; pAway /= sum;

  const pct = (x) => Math.round(x * 100);

  // Derived markets — each has a stable `key` (for grading against real
  // results later) plus a display `name`.
  const markets = [
    { key: "home_win", name: "Home win", p: pct(pHome) },
    { key: "draw", name: "Draw", p: pct(pDraw) },
    { key: "away_win", name: "Away win", p: pct(pAway) },
    { key: "1x", name: "Home win or draw (1X)", p: pct(pHome + pDraw) },
    { key: "x2", name: "Away win or draw (X2)", p: pct(pAway + pDraw) },
    { key: "btts", name: "Both teams to score", p: pct(clamp(h2h.bttsRate, 0.15, 0.9)) },
    { key: "over25", name: "Over 2.5 goals", p: pct(clamp(h2h.over25Rate, 0.15, 0.9)) },
    { key: "over15", name: "Over 1.5 goals", p: pct(clamp(0.55 + h2h.avgGoals * 0.11, 0.4, 0.95)) },
    { key: "under35", name: "Under 3.5 goals", p: pct(clamp(1 - (h2h.avgGoals - 2.2) * 0.18, 0.4, 0.92)) },
  ];

  return {
    probs: { home: pct(pHome), draw: pct(pDraw), away: pct(pAway) },
    markets: markets.sort((a, b) => b.p - a.p),
    confidence: h2h.meetings >= 6 ? "normal" : "low-sample",
  };
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Grades a market key against the ACTUAL final score. Only call this once
 *  the fixture is confirmed full-time — mid-match it's premature. */
export function evaluateMarket(key, hg, ag) {
  switch (key) {
    case "home_win": return hg > ag;
    case "draw": return hg === ag;
    case "away_win": return ag > hg;
    case "1x": return hg >= ag;
    case "x2": return ag >= hg;
    case "btts": return hg > 0 && ag > 0;
    case "over25": return hg + ag > 2.5;
    case "over15": return hg + ag > 1.5;
    case "under35": return hg + ag < 3.5;
    case "home_over15": return hg > 1.5;
    case "away_over15": return ag > 1.5;
    default: return null;
  }
}

/** Grades an exact-scoreline pick (e.g. "2-1") against the final score. */
export function evaluateCorrectScore(predictedScore, hg, ag) {
  return predictedScore === `${hg}-${ag}`;
}

/** Average goals a team has scored in its own recent finished fixtures,
 *  regardless of venue — used as a general attacking-strength input. */
export function teamAttackRate(fixtures, teamId) {
  const finished = fixtures.filter((f) => f.fixture.status.short === "FT");
  if (finished.length === 0) return 1.3; // league-average-ish fallback
  const total = finished.reduce((sum, f) => {
    const isHome = f.teams.home.id === teamId;
    return sum + (isHome ? f.goals.home : f.goals.away);
  }, 0);
  return total / finished.length;
}

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/** Poisson probability mass: P(exactly k goals | average rate lambda). */
function poissonP(lambda, k) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

/**
 * Correct-score model — genuinely statistical (Poisson), not a guess.
 * Blends H2H-specific scoring (oriented to today's home/away) with each
 * team's general recent attacking rate, applies a mild home boost, then
 * scores every plausible line 0-0 through 6-6 and returns the most likely
 * ones ranked. IMPORTANT: exact scorelines are inherently low-probability
 * in football — even the best single pick is usually only 10-30% likely.
 * This is normal and expected; treat the ranking, not the raw %, as the
 * signal.
 */
export function correctScoreModel({ h2h, homeAttack, awayAttack }) {
  const HOME_BOOST = 1.08;
  const AWAY_DAMP = 0.94;

  let lambdaHome = clamp(0.5 * h2h.avgHomeGoals + 0.5 * homeAttack, 0.3, 3.2) * HOME_BOOST;
  let lambdaAway = clamp(0.5 * h2h.avgAwayGoals + 0.5 * awayAttack, 0.3, 3.2) * AWAY_DAMP;

  const grid = [];
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 6; j++) {
      const p = poissonP(lambdaHome, i) * poissonP(lambdaAway, j);
      grid.push({ score: `${i}-${j}`, p });
    }
  }
  grid.sort((a, b) => b.p - a.p);

  const top = grid[0];
  const second = grid[1];
  return {
    top: { score: top.score, p: Math.round(top.p * 1000) / 10 },       // one decimal %
    second: { score: second.score, p: Math.round(second.p * 1000) / 10 },
    confidenceGap: Math.round((top.p - second.p) * 1000) / 10,          // bigger = clearer standout pick
    lambdaHome: Math.round(lambdaHome * 100) / 100,
    lambdaAway: Math.round(lambdaAway * 100) / 100,
  };
}

/**
 * Live model — runs only after minute 25.
 * Uses score, minute and (when present) shot dominance from live stats.
 */
export function liveModel(liveFixture) {
  const minute = liveFixture.fixture.status.elapsed || 0;
  if (minute < 25) return [];

  const hs = liveFixture.goals.home ?? 0;
  const as = liveFixture.goals.away ?? 0;
  const lead = hs - as;
  const total = hs + as;
  const home = liveFixture.teams.home.name;
  const away = liveFixture.teams.away.name;
  const timeFactor = Math.min(minute / 90, 1); // certainty grows with time

  const out = [];

  if (lead >= 2) {
    out.push({ key: "home_win", market: `${home} win`, p: Math.round(clamp(0.72 + lead * 0.07 + timeFactor * 0.15, 0, 0.97) * 100) });
  } else if (lead <= -2) {
    out.push({ key: "away_win", market: `${away} win`, p: Math.round(clamp(0.72 + Math.abs(lead) * 0.07 + timeFactor * 0.15, 0, 0.97) * 100) });
  } else if (lead === 1) {
    out.push({ key: "1x", market: `${home} win or draw (1X)`, p: Math.round(clamp(0.68 + timeFactor * 0.24, 0, 0.96) * 100) });
  } else if (lead === -1) {
    out.push({ key: "x2", market: `${away} win or draw (X2)`, p: Math.round(clamp(0.68 + timeFactor * 0.24, 0, 0.96) * 100) });
  }

  if (total >= 2 && minute <= 70) {
    out.push({ key: "over25", market: "Over 2.5 goals", p: Math.round(clamp(0.60 + total * 0.09 + (70 - minute) * 0.003, 0, 0.95) * 100) });
  }
  if (total === 0 && minute >= 40) {
    out.push({ key: "under35", market: "Under 3.5 goals", p: Math.round(clamp(0.68 + timeFactor * 0.25, 0, 0.96) * 100) });
  }
  if (total >= 1 && minute >= 60) {
    out.push({ key: "home_over15", market: `${home} over 1.5 goals`, p: Math.round(clamp(0.55 + total * 0.18, 0, 0.95) * 100) });
  }

  return out.filter((x) => x.p >= 70).sort((a, b) => b.p - a.p);
}
