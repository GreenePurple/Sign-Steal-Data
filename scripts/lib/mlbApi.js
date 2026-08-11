/**
 * mlbApi.js — shared MLB Stats API helpers used by both fetchLineup40man.js (current rosters) and
 * fetchLegends.js (Hall of Fame + major award winners). No API key required.
 */
const API = 'https://statsapi.mlb.com/api/v1';

const DIVISION_CODE = { 200: 'ALW', 201: 'ALE', 202: 'ALC', 203: 'NLW', 204: 'NLE', 205: 'NLC' };

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

async function pool(items, worker, concurrency) {
  const out = new Array(items.length);
  let idx = 0;
  let done = 0;
  async function run() {
    while (idx < items.length) {
      const cur = idx++;
      try {
        out[cur] = await worker(items[cur], cur);
      } catch {
        out[cur] = null;
      }
      if (++done % 100 === 0) process.stdout.write(`  …${done}/${items.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return out;
}

function num(v) {
  if (v === undefined || v === null || v === '-' || v === '.---') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function yearOf(dateStr) {
  if (!dateStr) return undefined;
  const y = Number(String(dateStr).slice(0, 4));
  return Number.isFinite(y) ? y : undefined;
}

function eraOf(start) {
  if (!start) return 'modern';
  if (start >= 2015) return 'current';
  if (start >= 2010) return 'modern';
  return 'veteran';
}

/** Pull career hitting/pitching lines out of the stats hydrate groups. */
function careerStats(groups) {
  const out = {};
  for (const g of groups || []) {
    if ((g.type && g.type.displayName) !== 'career') continue;
    const split = g.splits && g.splits[0];
    if (!split) continue;
    const s = split.stat || {};
    const gn = g.group && g.group.displayName;
    if (gn === 'hitting') {
      Object.assign(out, {
        G: num(s.gamesPlayed), AB: num(s.atBats), R: num(s.runs), H: num(s.hits),
        HR: num(s.homeRuns), RBI: num(s.rbi), BA: num(s.avg), OPS: num(s.ops), SLG: num(s.slg),
        B2: num(s.doubles), B3: num(s.triples), BB: num(s.baseOnBalls), KO: num(s.strikeOuts), SB: num(s.stolenBases),
      });
    } else if (gn === 'pitching') {
      Object.assign(out, {
        W: num(s.wins), L: num(s.losses), ERA: num(s.era), SO: num(s.strikeOuts),
        IP: num(s.inningsPitched), WHIP: num(s.whip), SV: num(s.saves), GS: num(s.gamesStarted),
      });
    }
  }
  return out;
}

/** Most-played career fielding position that isn't DH or pitcher — used to reposition DHs. */
function backupPosition(groups) {
  let best = null;
  for (const g of groups || []) {
    if ((g.type && g.type.displayName) !== 'career') continue;
    if ((g.group && g.group.displayName) !== 'fielding') continue;
    for (const sp of g.splits || []) {
      const pos = sp.position || (sp.stat && sp.stat.position) || {};
      const abbr = pos.abbreviation;
      if (!abbr || abbr === 'DH' || abbr === 'P') continue;
      const games = num((sp.stat && sp.stat.games)) || 0;
      if (!best || games > best.games) best = { abbr, type: pos.type || '', games };
    }
  }
  return best;
}

/** True if the player has ever been selected to an MLB All-Star Game (not a minor-league one). */
function isCareerAllStar(awards) {
  for (const a of awards || []) {
    if (a.id === 'ALAS' || a.id === 'NLAS') return true;
    if (/^(AL|NL) All-Star$/.test(a.name || '')) return true;
  }
  return false;
}

/** True if the player has been inducted into the National Baseball Hall of Fame. */
function isHallOfFamer(awards) {
  return (awards || []).some((a) => a.id === 'MLBHOF');
}

// Major-league hardware, keyed by the exact StatsAPI award id (league-prefixed). Exact ids only —
// `ASMVP` (All-Star MVP) and minor-league `*MVP`/`*ROY` ids must not count.
const ACCOLADE_IDS = {
  mvp: new Set(['ALMVP', 'NLMVP']),
  roy: new Set(['ALROY', 'NLROY']),
  cyYoung: new Set(['ALCY', 'NLCY']),
  goldGlove: new Set(['ALGG', 'NLGG']),
  silverSlugger: new Set(['ALSS', 'NLSS']),
  hrDerby: new Set(['HRDERBY']),
  hrDerbyWin: new Set(['HRDERBYWIN']),
};

/** Career major-league accolades for the Rundown clue ladder. Only truthy flags are emitted. */
function accoladesOf(awards) {
  const out = {};
  for (const [key, ids] of Object.entries(ACCOLADE_IDS)) {
    if ((awards || []).some((a) => ids.has(a.id))) out[key] = true;
  }
  return out;
}

/** The yearByYear splits for one specific stat group (e.g. 'hitting'), or `[]` if that group is absent. */
function yearByYearSplits(groups, group) {
  const g = (groups || []).find((x) => (x.type && x.type.displayName) === 'yearByYear' && (x.group && x.group.displayName) === group);
  return (g && g.splits) || [];
}

/**
 * Turn year-by-year splits into franchise stints in the order the player actually moved through
 * them: {id, abbr, name, startYear, endYear}. A new stint starts every time the team differs from
 * the row before it — including a *return* to an earlier team (TeamA, TeamB, TeamA stays three
 * stops) — so a comeback never silently re-merges into that team's first stint.
 *
 * Reads exactly one stat group's splits — `isPitcher` picks pitching over hitting, falling back to
 * the other (then fielding, as a last resort) only if the preferred one is completely empty. Mixing
 * groups (or using fielding, which repeats several rows per team per year — one per position played)
 * would interleave duplicate rows for the same year out of step with each other and fracture one real
 * stint into several phantom ones. The preference can't be "whichever group is non-empty" either: a
 * pitcher who logged a handful of interleague at-bats years ago (before the universal DH) has a
 * *sparse* hitting group that stops at his last such at-bat, years before his career actually ended —
 * picking it over pitching silently truncates the trail (missed the Mets stint and Astros return in
 * Justin Verlander's case, since his last NL at-bat predates both).
 *
 * When `currentTeamId` is given, the trail is guaranteed to end on that team — the game treats the
 * last entry as "now" (the avatar wears its cap, the Trail clue redacts it). Sequential stint-walking
 * already keeps the splits in true chronological order (including any in-season move), so the only
 * remaining gap is a current stint with *no* stats split of its own yet — a just-arrived signing, or
 * a comeback return before they've thrown a pitch or taken an at-bat in it. When that's the team the
 * trail already ends on, nothing to do. Otherwise a fresh stint is appended for it, dated by `season`.
 * Critically, that new stint is always *appended*, never spliced in from an earlier occurrence of the
 * same team — a player back for a second stint with no games logged yet would otherwise have their
 * stale first stint (with its old, long-past start year) yanked out of the middle of the trail and
 * relabeled "now", which reads as if they never left.
 * Retired players (no `currentTeamId`) don't need any of this — the trail just ends on their last
 * season, exactly as the stat splits recorded it.
 */
function teamHistory(groups, abbrMap, isPitcher, currentTeamId, currentMeta, season) {
  const hitting = yearByYearSplits(groups, 'hitting');
  const pitching = yearByYearSplits(groups, 'pitching');
  const preferred = isPitcher ? pitching : hitting;
  const fallback = isPitcher ? hitting : pitching;
  const splits = preferred.length ? preferred : fallback.length ? fallback : yearByYearSplits(groups, 'fielding');

  const stints = [];
  for (const sp of splits) {
    const team = sp.team;
    const yr = Number(sp.season);
    if (!team || !team.id || !Number.isFinite(yr)) continue;
    const last = stints[stints.length - 1];
    if (last && last.id === team.id) {
      last.endYear = Math.max(last.endYear, yr);
    } else {
      stints.push({ id: team.id, name: team.name, abbr: abbrMap[team.id] || team.abbreviation || '', startYear: yr, endYear: yr });
    }
  }

  if (currentTeamId && stints[stints.length - 1]?.id !== currentTeamId) {
    stints.push({
      id: currentTeamId,
      name: (currentMeta && currentMeta.name) || '',
      abbr: (currentMeta && currentMeta.abbr) || abbrMap[currentTeamId] || '',
      startYear: season, endYear: season,
    });
  }

  return stints;
}

/** Whether one game's line clears each "notable" bar — used by the postseason moment scan below.
 *  App repo mirror: src/state/GameContext.tsx uses the season-mode recentWalkoff/recentHero/
 *  recentHighlight fields with this exact same threshold logic; keep both in lockstep. */
function gameHighlightFlags(stat, isPitcher, isWin, isHome) {
  const hr = num(stat.homeRuns) ?? 0;
  const rbi = num(stat.rbi) ?? 0;
  const hits = num(stat.hits) ?? 0;
  const so = num(stat.strikeOuts) ?? 0;
  const walks = num(stat.baseOnBalls) ?? 0;
  const er = num(stat.earnedRuns) ?? 0;
  const ip = num(stat.inningsPitched) ?? 0;
  const sv = num(stat.saves) ?? 0;

  const walkoff = !isPitcher && isWin && isHome && hr >= 1 && rbi >= 1;
  const hero = (!isPitcher && (hr >= 1 || rbi >= 3 || hits >= 3)) ||
    (isPitcher && ((sv >= 1 && isWin) || (isWin && ip >= 5 && er <= 2)));
  const highlight = hero || (!isPitcher && hits >= 4) || (isPitcher && (so >= 5 || (ip >= 6 && er <= 2)));
  const blunder = !isWin && ((!isPitcher && so >= 3 && hits <= 1) || (isPitcher && (er >= 4 || (walks >= 3 && hits >= 6))));

  return { walkoff, hero, highlight, blunder };
}

// How postseason candidate games are ranked against each other once they've cleared
// gameHighlightFlags' bar — a walk-off always wins outright; otherwise the biggest individual line.
function momentScore(stat, isPitcher, walkoff) {
  if (walkoff) return 10000;
  if (isPitcher) {
    const so = num(stat.strikeOuts) ?? 0;
    const sv = num(stat.saves) ?? 0;
    const ip = num(stat.inningsPitched) ?? 0;
    const er = num(stat.earnedRuns) ?? 0;
    return so * 3 + (sv >= 1 ? 30 : 0) + Math.max(0, ip - er * 2) * 4;
  }
  const hr = num(stat.homeRuns) ?? 0;
  const rbi = num(stat.rbi) ?? 0;
  const hits = num(stat.hits) ?? 0;
  return hr * 40 + rbi * 8 + hits * 3;
}

// gameType codes (see /api/v1/gameTypes): F=Wild Card, D=Division Series, L=Championship Series,
// W=World Series. D/L need the league (103=AL/104=NL) to become ALDS/NLDS or ALCS/NLCS. Fallback
// only — seriesInfoFor below is the authoritative source; this covers it being unreachable.
function roundNameFor(gameType, leagueId) {
  const isAL = leagueId === 103;
  if (gameType === 'F') return 'Wild Card';
  if (gameType === 'D') return isAL ? 'ALDS' : 'NLDS';
  if (gameType === 'L') return isAL ? 'ALCS' : 'NLCS';
  return 'World Series';
}

function roundNameFromDescription(desc) {
  if (!desc) return undefined;
  if (/wild card/i.test(desc)) return 'Wild Card';
  if (/division series/i.test(desc)) return /^AL/.test(desc) ? 'ALDS' : 'NLDS';
  if (/championship series/i.test(desc)) return /^AL/.test(desc) ? 'ALCS' : 'NLCS';
  if (/world series/i.test(desc)) return 'World Series';
  return undefined;
}

/**
 * Authoritative round name + which game of the series, for one specific gamePk — needed because a
 * postseason game log split's own `gameType` field is only reliable for the hitting group (it
 * correctly reports D/L/W there) but comes back as the generic umbrella `"P"` for the pitching
 * group, which would otherwise mislabel every pitcher's moment as the World Series (the
 * `roundNameFor` fallback's default). The schedule endpoint reports both correctly regardless of
 * group, plus `seriesGameNumber` (Game 1, 2, 3...), which the pitcher-only "started Game 1" framing
 * in the Rundown clue needs.
 */
async function seriesInfoFor(gamePk) {
  try {
    const sched = await getJSON(`${API}/schedule?gamePk=${gamePk}`);
    const g = sched.dates && sched.dates[0] && sched.dates[0].games && sched.dates[0].games[0];
    if (!g) return null;
    const round = roundNameFromDescription(g.seriesDescription) || roundNameFor(g.gameType, undefined);
    return { round, gameNumber: g.seriesGameNumber };
  } catch {
    return null;
  }
}

/**
 * The player's single most notable postseason game across their whole career, for the Rundown
 * "Moment" clue — or `undefined` if none clears gameHighlightFlags' bar (true of most players,
 * including anyone with no postseason experience at all).
 *
 * Three calls minimum, only for players who ever reached the postseason: a cheap career-totals
 * check (skip everyone else in one call), a year list (yearByYear must use the *direct*
 * `stats=yearByYear&gameType=P` endpoint — the nested `hydrate=stats(type=[yearByYearPlayoffs])`
 * form silently ignores the postseason filter and returns regular-season totals instead), then one
 * game log per postseason year played. Two final calls resolve the winning game's authoritative
 * round/game-number (seriesInfoFor) and, for hitters only, its batting order.
 */
async function postseasonMomentOf(id, isPitcher) {
  const group = isPitcher ? 'pitching' : 'hitting';

  const careerData = await getJSON(`${API}/people/${id}/stats?stats=career&group=${group}&sportIds=1&gameType=P`);
  const careerStat = careerData.stats && careerData.stats[0] && careerData.stats[0].splits && careerData.stats[0].splits[0] && careerData.stats[0].splits[0].stat;
  const workload = careerStat && (isPitcher ? num(careerStat.inningsPitched) : num(careerStat.plateAppearances));
  if (!workload) return undefined;

  const ybyData = await getJSON(`${API}/people/${id}/stats?stats=yearByYear&group=${group}&sportIds=1&gameType=P`);
  const years = ((ybyData.stats && ybyData.stats[0] && ybyData.stats[0].splits) || []).map((s) => s.season).filter(Boolean);
  if (years.length === 0) return undefined;

  let best = null;
  for (const year of years) {
    const logData = await getJSON(`${API}/people/${id}/stats?stats=gameLog&season=${year}&group=${group}&sportIds=1&gameType=P`);
    for (const sp of (logData.stats && logData.stats[0] && logData.stats[0].splits) || []) {
      const stat = sp.stat || {};
      const flags = gameHighlightFlags(stat, isPitcher, sp.isWin === true, sp.isHome === true);
      if (!flags.walkoff && !flags.highlight) continue;
      const score = momentScore(stat, isPitcher, flags.walkoff);
      if (!best || score > best.score) best = { sp, stat, score, walkoff: flags.walkoff };
    }
  }
  if (!best) return undefined;

  const gamePk = best.sp.game && best.sp.game.gamePk;
  const info = gamePk ? await seriesInfoFor(gamePk) : null;
  const moment = {
    year: Number(best.sp.season),
    round: (info && info.round) || roundNameFor(best.sp.gameType, best.sp.league && best.sp.league.id),
  };
  if (info && info.gameNumber) moment.gameNumber = info.gameNumber;
  if (isPitcher) {
    if (num(best.stat.strikeOuts)) moment.so = num(best.stat.strikeOuts);
    if (num(best.stat.inningsPitched)) moment.ip = num(best.stat.inningsPitched);
    if (num(best.stat.saves)) moment.sv = num(best.stat.saves);
  } else {
    if (num(best.stat.homeRuns)) moment.hr = num(best.stat.homeRuns);
    if (num(best.stat.rbi)) moment.rbi = num(best.stat.rbi);
    if (num(best.stat.hits)) moment.hits = num(best.stat.hits);
  }
  if (best.walkoff) moment.walkoff = true;

  if (!isPitcher && gamePk) {
    try {
      const box = await getJSON(`${API}/game/${gamePk}/boxscore`);
      const key = `ID${id}`;
      const side = box.teams && box.teams.home && box.teams.home.players && box.teams.home.players[key]
        ? 'home'
        : box.teams && box.teams.away && box.teams.away.players && box.teams.away.players[key]
          ? 'away'
          : null;
      const order = side && box.teams[side].players[key].battingOrder;
      if (order) {
        const slot = Math.floor(Number(order) / 100);
        if (slot >= 1 && slot <= 9) moment.battingOrder = slot;
      }
    } catch {
      /* best-effort — moment still stands without a batting-order detail */
    }
  }

  return moment;
}

// All-Star Game starters, cached per SEASON rather than per player — the boxscore lookup doesn't
// vary by player, so every player selected in a given year shares one lookup. Bounds the total added
// cost to roughly one schedule + one boxscore call per distinct All-Star *season* represented across
// the whole pool (~90 across MLB history), not one per player, however many times they were picked.
// The Map stores the in-flight promise itself (not just the eventual Set) so concurrent callers for
// a season neither of them has seen yet share the same fetch instead of triggering it twice.
const asgStarterCache = new Map();

async function fetchAllStarStarters(season) {
  const starters = new Set();
  try {
    const sched = await getJSON(`${API}/schedule?sportId=1&gameType=A&season=${season}`);
    const gamePks = [];
    for (const date of sched.dates || []) {
      for (const g of date.games || []) gamePks.push(g.gamePk);
    }
    for (const pk of gamePks) {
      const box = await getJSON(`${API}/game/${pk}/boxscore`);
      for (const side of ['home', 'away']) {
        const team = box.teams && box.teams[side];
        if (!team || !team.players) continue;
        for (const player of Object.values(team.players)) {
          // battingOrder "X00" is the original starting lineup slot X; "X01"+ is a substitute who
          // entered later at that same spot — only the "00" suffix means they started the game.
          const bo = player.battingOrder;
          if (bo && Number(bo) % 100 === 0) starters.add(player.person.id);
        }
        if (team.pitchers && team.pitchers.length) starters.add(team.pitchers[0]);
      }
    }
  } catch {
    /* best-effort — an unresolved season just yields no recorded starters for it */
  }
  return starters;
}

function allStarStartersFor(season) {
  if (!asgStarterCache.has(season)) asgStarterCache.set(season, fetchAllStarStarters(season));
  return asgStarterCache.get(season);
}

/** True if any of the player's All-Star selections (from their already-fetched `awards` list) was
 *  as a starter, not just a roster spot. */
async function isAllStarStarter(id, awards) {
  const seasons = (awards || []).filter((a) => a.id === 'ALAS' || a.id === 'NLAS').map((a) => a.season).filter(Boolean);
  for (const season of seasons) {
    const starters = await allStarStartersFor(season);
    if (starters.has(id)) return true;
  }
  return false;
}

module.exports = {
  API,
  DIVISION_CODE,
  getJSON,
  pool,
  num,
  yearOf,
  eraOf,
  careerStats,
  backupPosition,
  isCareerAllStar,
  isHallOfFamer,
  ACCOLADE_IDS,
  accoladesOf,
  teamHistory,
  gameHighlightFlags,
  postseasonMomentOf,
  isAllStarStarter,
};
