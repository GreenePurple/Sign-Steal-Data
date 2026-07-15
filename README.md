# Sign-Steal-Data

Daily fetch of MLB Stats API data for the [SignSteal](https://github.com/GreenePurple/Sign-Steal)
app's "Who's in the Box?" guess pool.

[.github/workflows/refresh.yml](.github/workflows/refresh.yml) runs
[scripts/fetchLineup40man.js](scripts/fetchLineup40man.js) daily at 09:00 UTC and commits
[lineup_40man_2026.json](lineup_40man_2026.json) back to `main` when the data changed. The
SignSteal app polls the published raw file (at most once a day) via
`EXPO_PUBLIC_ROSTER_URL` / `src/data/rosterSource.ts`:

```
https://raw.githubusercontent.com/GreenePurple/Sign-Steal-Data/main/lineup_40man_2026.json
```

## What the fetch builds

- **Guess pool** — every player on a 2026 active 26-man roster or any injured list (10/15/60-day).
  Minor-league assignees are excluded.
- **Daily-target fields** (`seasonPA`, `seasonIP`, `seasonSV`, `allStar`) — used by the app to pick
  the deterministic daily answer from "impact" players only (≥100 PA, ≥30 IP, ≥10 SV this season,
  or a career All-Star). See the app's [CLAUDE.md](https://github.com/GreenePurple/Sign-Steal/blob/main/CLAUDE.md)
  for the full rules.

Source: `statsapi.mlb.com` (no API key required).

## Running it by hand

```bash
npm install
npm run fetch
```

Writes `lineup_40man_2026.json` to the repo root. Takes a few minutes (one API call per
guess-pool player, plus a best-effort headshot skin-tone sample per player via `jimp`).

## One-time repo setup for the scheduled workflow to push

GitHub Actions' default `GITHUB_TOKEN` is read-only on repos created after Feb 2023. Enable write
access once: **Settings → Actions → General → Workflow permissions → "Read and write permissions"**.
Without this, the daily run fetches fine but the commit/push step fails.

## Triggering a run manually

Actions tab → "Daily roster refresh" → **Run workflow** (the workflow also has
`workflow_dispatch` enabled for this).
