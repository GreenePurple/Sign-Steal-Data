/**
 * fetchLineup40man.js — Node 18+ (global fetch). No API key required.
 *
 *   node scripts/fetchLineup40man.js
 *
 * Builds the dataset for the SignSteal daily game mode from the 2026 MLB rosters.
 *
 *   • GUESS POOL    = every player on an active 26-man roster or any injured list
 *                     (10/15/60-day). Minor-league assignees are excluded. Anyone in
 *                     this pool can be searched / guessed.
 *   • DAILY TARGET  = the mystery player, drawn only from "impact" players in the pool:
 *                     >= 100 PA, >= 30 IP, or >= 10 SV in 2026, OR a career MLB All-Star.
 *                     (Target eligibility is applied in src/state/GameContext.tsx.)
 *
 * Writes lineup_40man_2026.json to the repo root. Run by .github/workflows/refresh.yml on a
 * daily cron so roster moves, IL changes, and players crossing a baseline come along; the
 * SignSteal app (github.com/GreenePurple/Sign-Steal) reads the published raw file at
 * EXPO_PUBLIC_ROSTER_URL / src/data/rosterSource.ts and picks up changes at most once a day.
 *
 * Each record matches the app's Player shape (career stats power the Signal board +
 * team history) plus the SignSteal-mode fields that drive target eligibility:
 *   seasonPA — plate appearances in the 2026 regular season
 *   seasonIP — innings pitched in the 2026 regular season
 *   seasonSV — saves in the 2026 regular season
 *   allStar  — true if they've been an MLB All-Star at any point in their career
 */
const fs = require('fs');
const path = require('path');
const { addSkins } = require('./skinTone');

const API = 'https://statsapi.mlb.com/api/v1';
const SEASON = 2026;
const CONCURRENCY = 25;
const OUT = path.join(__dirname, '..', 'lineup_40man_2026.json');

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

/** Hitting PA + pitching IP / SV in the requested season (0 when the player has none). */
function seasonStatsOf(groups) {
  const out = { seasonPA: 0, seasonIP: 0, seasonSV: 0 };
  for (const grp of groups || []) {
    if ((grp.type && grp.type.displayName) !== 'season') continue;
    const split = grp.splits && grp.splits[0];
    if (!split || String(split.season) !== String(SEASON)) continue;
    const s = split.stat || {};
    const gn = grp.group && grp.group.displayName;
    if (gn === 'hitting') out.seasonPA = Math.max(out.seasonPA, num(s.plateAppearances) || 0);
    else if (gn === 'pitching') {
      out.seasonIP = Math.max(out.seasonIP, num(s.inningsPitched) || 0);
      out.seasonSV = Math.max(out.seasonSV, num(s.saves) || 0);
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

/**
 * Collapse year-by-year splits into one stint per franchise: {id, abbr, name, startYear, endYear}.
 * The trail must end on the player's *current* team — the game treats the last entry as "now" (the
 * avatar wears its cap, the Trail clue redacts it). The current team comes from the live roster, not
 * the stats splits, so two cases would otherwise break that invariant and mislead the clue:
 *   • an offseason arrival has no SEASON stats split yet → the team is absent from the trail entirely;
 *   • an in-season move leaves two same-SEASON stints → the current team may not sort last.
 * Passing the current team id + meta lets us guarantee it is present and tail-most.
 */
function teamHistory(groups, abbrMap, currentTeamId, currentMeta) {
  const byTeam = {};
  for (const grp of groups || []) {
    if ((grp.type && grp.type.displayName) !== 'yearByYear') continue;
    for (const sp of grp.splits || []) {
      const team = sp.team;
      const season = Number(sp.season);
      if (!team || !team.id || !Number.isFinite(season)) continue;
      const e = byTeam[team.id] || {
        id: team.id, name: team.name, abbr: abbrMap[team.id] || team.abbreviation || '',
        startYear: season, endYear: season,
      };
      e.startYear = Math.min(e.startYear, season);
      e.endYear = Math.max(e.endYear, season);
      byTeam[team.id] = e;
    }
  }

  if (currentTeamId) {
    byTeam[currentTeamId] = byTeam[currentTeamId] || {
      id: currentTeamId,
      name: (currentMeta && currentMeta.name) || '',
      abbr: (currentMeta && currentMeta.abbr) || abbrMap[currentTeamId] || '',
      startYear: SEASON, endYear: SEASON,
    };
  }

  const list = Object.values(byTeam).sort((a, b) => a.startYear - b.startYear || a.endYear - b.endYear);
  if (currentTeamId) {
    const i = list.findIndex((t) => t.id === currentTeamId);
    if (i >= 0 && i !== list.length - 1) list.push(list.splice(i, 1)[0]);
  }
  return list;
}

async function main() {
  console.log(`SignSteal · building ${SEASON} guess pool (active rosters + ILs)`);

  // Teams for the season → division / league / abbreviation lookup (sportId=1 = MLB).
  const teamsData = await getJSON(`${API}/teams?sportId=1&season=${SEASON}`);
  const teams = (teamsData.teams || []).filter((t) => t.sport && t.sport.id === 1 && t.active !== false);
  const teamMeta = {};
  const abbrMap = {};
  for (const t of teams) {
    abbrMap[t.id] = t.abbreviation;
    teamMeta[t.id] = {
      abbr: t.abbreviation,
      name: t.name,
      div: DIVISION_CODE[t.division && t.division.id] || '',
      league: (t.league && t.league.id) === 103 ? 'AL' : (t.league && t.league.id) === 104 ? 'NL' : '',
    };
  }
  console.log(`Found ${teams.length} MLB teams.`);

  // Guess pool = active 26-man rosters + injured lists. The 40-man roster carries a status
  // per player; we keep "Active" and any Injured-List status and drop minor-league assignees.
  // One entry per player (id → their team).
  console.log('Fetching rosters…');
  const onRoster = new Map();
  for (const t of teams) {
    const data = await getJSON(`${API}/teams/${t.id}/roster?rosterType=40Man&season=${SEASON}`);
    for (const r of data.roster || []) {
      const status = r.status || {};
      const inPool = status.code === 'A' || /injured/i.test(status.description || '');
      if (inPool) onRoster.set(r.person.id, t.id);
    }
  }
  const ids = [...onRoster.keys()];
  console.log(`${ids.length} players in the guess pool (active rosters + injured lists).`);

  // Bio + career stats + season games + team history, one player at a time.
  console.log('Fetching bios + stats…');
  const records = await pool(
    ids,
    async (id) => {
      const data = await getJSON(
        `${API}/people/${id}?hydrate=stats(group=[hitting,pitching,fielding],type=[career,season,yearByYear],season=${SEASON}),awards`
      );
      const p = data.people && data.people[0];
      if (!p) return null;
      const currentTeamId = onRoster.get(id);
      const meta = teamMeta[currentTeamId] || {};
      const pos = p.primaryPosition || {};
      const isPitcher = pos.type === 'Pitcher';
      const stats = careerStats(p.stats);
      const start = yearOf(p.mlbDebutDate);
      const end = yearOf(p.lastPlayedDate);
      const role = isPitcher ? (num(stats.GS) && stats.GS >= 10 ? 'SP' : 'RP') : undefined;
      // A DH carries no fielding group; reassign to their most-played real position so the
      // position clue still works. True career DHs (no fielding history) stay an ungrouped "DH".
      const backup = pos.type === 'Hitter' ? backupPosition(p.stats) : null;
      let position;
      let positionGroup;
      if (isPitcher) {
        position = role;
        positionGroup = pos.type;
      } else if (pos.type === 'Hitter') {
        position = backup ? backup.abbr : 'DH';
        positionGroup = backup ? backup.type : '';
      } else {
        position = pos.abbreviation || '';
        positionGroup = pos.type || '';
      }
      return {
        id: p.id,
        name: p.fullName,
        team: meta.abbr || '',
        teamName: meta.name || '',
        div: meta.div || '',
        league: meta.league || '',
        position,
        positionGroup,
        bats: (p.batSide && p.batSide.code) || '',
        throws: (p.pitchHand && p.pitchHand.code) || '',
        era: eraOf(start),
        startYear: start,
        endYear: end,
        ...seasonStatsOf(p.stats),
        allStar: isCareerAllStar(p.awards),
        ...accoladesOf(p.awards),
        stats,
        teams: teamHistory(p.stats, abbrMap, currentTeamId, meta),
      };
    },
    CONCURRENCY
  );

  const players = records.filter(Boolean);

  // Skin tone for the Rundown avatars, sampled from each player's official MLB headshot. Done here
  // so the app pays nothing at runtime; best-effort, so it never blocks the build.
  console.log('Sampling headshot skin tones…');
  const matched = await addSkins(players, CONCURRENCY, (m) => process.stdout.write(`${m}\r`));
  console.log(`\nSkin tones matched for ${matched}/${players.length} players.`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(players, null, 0));

  const eligible = players.filter(
    (p) => (p.seasonPA || 0) >= 100 || (p.seasonIP || 0) >= 30 || (p.seasonSV || 0) >= 10 || p.allStar
  ).length;
  console.log(`\nDone — wrote ${players.length} guessable players to ${path.relative(process.cwd(), OUT)}`);
  console.log(`Daily-target pool (>=100 PA / >=30 IP / >=10 SV in ${SEASON}, or career All-Star): ${eligible} players.`);
}

main().catch((e) => {
  console.error('\nFETCH FAILED:', e.message);
  process.exit(1);
});
