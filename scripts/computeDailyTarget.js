/**
 * computeDailyTarget.js — Node 18+
 *
 *   node scripts/computeDailyTarget.js
 *
 * Precomputes and publishes the "Who's in the Box?" daily answer, instead of leaving every
 * client to derive it independently from whatever roster snapshot and app-version algorithm it
 * happens to be running (which produced two different answers on two different devices for the
 * same date). Run right after fetchLineup40man.js in the daily cron, against the roster file it
 * just wrote — this becomes the single source of truth every client looks up by date.
 *
 * Adds entries for today and tomorrow (UTC) so any device's *local* calendar date — which can be
 * a day off from the cron's UTC run time depending on timezone — already has a published answer
 * by the time it rolls over. Never overwrites a date that's already published, so a re-run (retry,
 * manual workflow_dispatch) can't silently change an answer that may already be live.
 *
 * Picks are also checked for a "twin": another guessable player who reads identically on all five
 * hint columns (team, division, position, throwing arm, debut year). A target with a twin would
 * let a wrong guess light up all green, so twins are skipped in favor of the next-best candidate.
 */
const fs = require('fs');
const path = require('path');

const ROSTER_FILE = path.join(__dirname, '..', 'lineup_40man_2026.json');
const OUT = path.join(__dirname, '..', 'daily_targets.json');

// Same hash + eligibility rules as the app's src/utils/similarity.ts / src/state/GameContext.ts —
// kept in lockstep so a local fallback pick (for a date this file hasn't published yet) agrees
// with what this script would have chosen.
function hash32(a, b) {
  let h = (Math.imul(a, 2654435761) ^ b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return h >>> 0;
}

function seeded(n) {
  const x = Math.sin(n) * 10000;
  return x - Math.floor(x);
}

function ymdNumber(y, m, d) {
  return y * 10000 + m * 100 + d;
}

function targetPoolFrom(players) {
  return players.filter(
    (p) => (p.seasonPA ?? 0) >= 100 || (p.seasonIP ?? 0) >= 30 || (p.seasonSV ?? 0) >= 10 || p.allStar === true,
  );
}

/** True if `candidate` reads identically to some other guessable player on every hint column. */
function hasTwin(candidate, fullPool) {
  return fullPool.some(
    (p) =>
      p.id !== candidate.id &&
      p.team === candidate.team &&
      p.div === candidate.div &&
      p.position === candidate.position &&
      p.throws === candidate.throws &&
      p.startYear === candidate.startYear,
  );
}

/** Best-scoring candidate that has no twin in the full guessable pool. */
function pickDailyTarget(targetPool, fullPool, dayKey) {
  const ranked = targetPool
    .map((p) => ({ p, score: seeded(hash32(dayKey, p.id)) }))
    .sort((a, b) => b.score - a.score);
  const winner = ranked.find(({ p }) => !hasTwin(p, fullPool));
  return (winner ?? ranked[0])?.p;
}

function utcDateParts(d) {
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function isoDate({ y, m, day }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function main() {
  const players = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
  const pool = targetPoolFrom(players);
  console.log(`Loaded ${players.length} guessable players, ${pool.length} target-eligible.`);

  let published = [];
  if (fs.existsSync(OUT)) {
    try {
      published = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    } catch {
      published = [];
    }
  }
  const already = new Set(published.map((e) => e.date));

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const candidates = [utcDateParts(now), utcDateParts(tomorrow)];

  let added = 0;
  for (const parts of candidates) {
    const date = isoDate(parts);
    if (already.has(date)) {
      console.log(`${date} already published — leaving it as-is.`);
      continue;
    }
    const dayKey = ymdNumber(parts.y, parts.m, parts.day);
    const target = pickDailyTarget(pool, players, dayKey);
    if (!target) {
      console.error(`No eligible target found for ${date} — skipping.`);
      continue;
    }
    published.push({ date, targetId: target.id, name: target.name });
    already.add(date);
    added++;
    console.log(`${date} -> ${target.name} (id ${target.id})`);
  }

  published.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(OUT, JSON.stringify(published, null, 2) + '\n');
  console.log(`\nWrote ${published.length} total entries (${added} new) to ${path.relative(process.cwd(), OUT)}.`);
}

main();
