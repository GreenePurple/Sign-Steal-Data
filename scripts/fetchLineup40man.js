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
 * Kept in lockstep with the copy in the SignSteal app repo (scripts/fetchLineup40man.js) — if
 * you change one, change both, or a field the app depends on (e.g. seasonStats) can silently
 * disappear from published data even though this script still runs "successfully".
 *
 * Each record matches the app's Player shape (career stats power the Signal board +
 * team history) plus the SignSteal-mode fields that drive target eligibility:
 *   seasonPA    — plate appearances in the 2026 regular season
 *   seasonIP    — innings pitched in the 2026 regular season
 *   seasonSV    — saves in the 2026 regular season
 *   seasonStats — this year's batting/pitching line (AVG/HR/RBI/OPS or W/L/ERA/SO/WHIP), for the
 *                 reveal cards — distinct from `stats`, which is career totals
 *   allStar     — true if they've been an MLB All-Star at any point in their career
 *   moment      — Beat the Clock clue: their single most notable career postseason game, if any
 *                 (see postseasonMomentOf in scripts/lib/mlbApi.js)
 */
const fs = require('fs');
const path = require('path');
const { addSkins } = require('./skinTone');
const {
  getJSON, pool, num, yearOf, eraOf, careerStats, backupPosition,
  isCareerAllStar, accoladesOf, teamHistory, postseasonMomentOf, isAllStarStarter,
} = require('./lib/mlbApi');

const API = 'https://statsapi.mlb.com/api/v1';
const SEASON = 2026;
const CONCURRENCY = 25;
const OUT = path.join(__dirname, '..', 'lineup_40man_2026.json');

const DIVISION_CODE = { 200: 'ALW', 201: 'ALE', 202: 'ALC', 203: 'NLW', 204: 'NLE', 205: 'NLC' };

/** Hitting PA + pitching IP / SV in the requested season (0 when the player has none), plus the
 *  2026-only display line (AVG/HR/RBI/OPS or W/L/ERA/SO/WHIP) for the reveal cards. */
function seasonStatsOf(groups) {
  const out = { seasonPA: 0, seasonIP: 0, seasonSV: 0, seasonStats: {} };
  for (const grp of groups || []) {
    if ((grp.type && grp.type.displayName) !== 'season') continue;
    const split = grp.splits && grp.splits[0];
    if (!split || String(split.season) !== String(SEASON)) continue;
    const s = split.stat || {};
    const gn = grp.group && grp.group.displayName;
    if (gn === 'hitting') {
      out.seasonPA = Math.max(out.seasonPA, num(s.plateAppearances) || 0);
      Object.assign(out.seasonStats, { AVG: num(s.avg), HR: num(s.homeRuns), RBI: num(s.rbi), OPS: num(s.ops) });
    } else if (gn === 'pitching') {
      out.seasonIP = Math.max(out.seasonIP, num(s.inningsPitched) || 0);
      out.seasonSV = Math.max(out.seasonSV, num(s.saves) || 0);
      Object.assign(out.seasonStats, { W: num(s.wins), L: num(s.losses), ERA: num(s.era), SO: num(s.strikeOuts), WHIP: num(s.whip) });
    }
  }
  return out;
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
      const moment = await postseasonMomentOf(id, isPitcher);
      const allStar = isCareerAllStar(p.awards);
      const allStarStarter = allStar && (await isAllStarStarter(id, p.awards));
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
        allStar,
        ...(allStarStarter ? { allStarStarter: true } : {}),
        ...accoladesOf(p.awards),
        ...(moment ? { moment } : {}),
        stats,
        teams: teamHistory(p.stats, abbrMap, isPitcher, currentTeamId, meta, SEASON),
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
