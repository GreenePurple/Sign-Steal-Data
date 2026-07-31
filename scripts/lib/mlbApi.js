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
};
