/**
 * skinTone.js — derive a player's skin tone from their official MLB headshot, once at build time
 * (no API key, no runtime cost). Used by fetchLineup40man.js; also runnable standalone to backfill
 * an existing dataset:
 *
 *   node -e "const {addSkins}=require('./scripts/skinTone');const fs=require('fs');const f='./assets/data/lineup_40man_2026.json';const p=JSON.parse(fs.readFileSync(f));addSkins(p,25,console.log).then(m=>{fs.writeFileSync(f,JSON.stringify(p,null,0));console.log('matched',m);})"
 *
 * Best-effort: any miss leaves the player without a `skin`, and the avatar falls back to a tone
 * picked from the name hash — so this never blocks the pipeline.
 */

// Mirror of the avatar's SKINS palette (src/components/PlayerAvatar.tsx); sampled tones snap to the
// nearest of these so the cartoon look stays consistent.
const SKIN_PALETTE = ['#F7D5BA', '#EFC4A0', '#E0AC83', '#C68A5E', '#A56A41', '#7C4A2D'];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const PALETTE_RGB = SKIN_PALETTE.map(hexToRgb);

function snapSkin(r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < PALETTE_RGB.length; i++) {
    const [pr, pg, pb] = PALETTE_RGB[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return SKIN_PALETTE[best];
}

let jimp = null; // null = not tried, false = unavailable
function loadJimp() {
  if (jimp === null) {
    try {
      const mod = require('jimp');
      jimp = mod.Jimp || mod.default || mod;
    } catch {
      jimp = false;
    }
  }
  return jimp;
}

async function decodeBitmap(buffer) {
  const J = loadJimp();
  if (!J) return null;
  const img = J.fromBuffer ? await J.fromBuffer(buffer) : await J.read(buffer);
  return img.bitmap; // { data: RGBA Buffer, width, height }
}

/** Average the face-region skin pixels of one player's MLB headshot, snapped to the palette. */
async function skinForPlayer(id) {
  const res = await fetch(`https://midfield.mlbstatic.com/v1/people/${id}/spots/120`);
  if (!res.ok) return undefined;
  const bmp = await decodeBitmap(Buffer.from(await res.arrayBuffer()));
  if (!bmp) return undefined;

  const { data, width, height } = bmp;
  // A central box over the cheeks/lower face — above the jersey, away from the eyes.
  const x0 = Math.floor(width * 0.32);
  const x1 = Math.ceil(width * 0.68);
  const y0 = Math.floor(height * 0.38);
  const y1 = Math.ceil(height * 0.66);
  const px = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 200) continue; // transparent background
      if (r + g + b < 120) continue; // hair / shadow / pupils
      if (r > 240 && g > 240 && b > 240) continue; // highlights / sclera / teeth
      if (!(r >= g && g >= b && r - b >= 8 && r - b <= 130)) continue; // skin-ish hues only
      px.push([0.299 * r + 0.587 * g + 0.114 * b, r, g, b]);
    }
  }
  if (px.length < 25) return undefined; // not enough confident skin pixels
  // Average the brightest (lit) half of the skin pixels — cheeks/chin sit in shadow, so the plain
  // average reads too dark and collapses everyone onto the mid-tones.
  px.sort((a, b) => b[0] - a[0]);
  const take = Math.max(20, Math.round(px.length * 0.5));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let k = 0; k < take; k++) {
    sr += px[k][1];
    sg += px[k][2];
    sb += px[k][3];
  }
  return snapSkin(Math.round(sr / take), Math.round(sg / take), Math.round(sb / take));
}

/** Fill `skin` on each player in place (best-effort, bounded concurrency). Returns the match count. */
async function addSkins(players, concurrency = 20, log = () => {}) {
  if (!loadJimp()) {
    log('jimp not installed — skipping skin sampling (avatars use fallback tones). Install: npm i -D jimp');
    return 0;
  }
  let idx = 0;
  let done = 0;
  let matched = 0;
  async function run() {
    while (idx < players.length) {
      const p = players[idx++];
      try {
        const skin = await skinForPlayer(p.id);
        if (skin) {
          p.skin = skin;
          matched++;
        }
      } catch {
        /* leave the fallback tone */
      }
      if (++done % 100 === 0) log(`  …${done}/${players.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, players.length) }, run));
  return matched;
}

module.exports = { addSkins, skinForPlayer, snapSkin, loadJimp, SKIN_PALETTE };
