// Builds the standalone Quest Deck (GitHub Pages) at the repo root from the claude.ai artifact source app.html.
// Run: node web/build.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = root;
fs.mkdirSync(out, { recursive: true });

let app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const swap = (from, to) => { if (!app.includes(from)) throw new Error('build: marker not found: ' + from.slice(0, 60)); app = app.replace(from, to); };
swap('<title>Quest Deck</title>\n', '');
swap('<meta name="claude:viewport-fit-sides" content="cover">\n', '');
swap('<div class="sync" id="sync"><span class="dot"></span>Connecting…</div>',
  '<div style="display:flex;align-items:center;gap:2px"><div class="sync" id="sync"><span class="dot"></span>Connecting…</div>' +
  '<button class="btn ghost sm" id="cloud-btn" type="button" aria-label="Calendar and account" title="Calendar &amp; account">' +
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></button></div>');
// the AI coach needs claude.ai; hide it here
swap('</style>', '#coach-btn{display:none}\n</style>');

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Quest Deck</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Quest Deck">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#edf0f6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1322" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" href="icon-192.png">
<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0}</style>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
<script src="cloud.js"></script>
</head>
<body>
`;
fs.writeFileSync(path.join(out, 'index.html'), head + app + '\n</body>\n</html>\n');
fs.copyFileSync(path.join(root, 'web', 'cloud.js'), path.join(out, 'cloud.js'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify({
  name: 'Quest Deck', short_name: 'Quest Deck', start_url: './', scope: './', display: 'standalone',
  background_color: '#edf0f6', theme_color: '#3445c4',
  icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
}, null, 2));

// app icon: white check on the accent blue, 4x supersampled
function icon(size) {
  const bg = [0x34, 0x45, 0xc4], fg = [255, 255, 255], ss = 4;
  const pts = [[0.27, 0.53], [0.43, 0.68], [0.74, 0.35]], w = 0.085;
  const seg = (px, py, [ax, ay], [bx, by]) => {
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const px = (x + (sx + 0.5) / ss) / size, py = (y + (sy + 0.5) / ss) / size;
        if (Math.min(seg(px, py, pts[0], pts[1]), seg(px, py, pts[1], pts[2])) < w) hit++;
      }
      const a = hit / (ss * ss), o = y * (size * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(bg[c] + (fg[c] - bg[c]) * a);
    }
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [180, 192, 512]) fs.writeFileSync(path.join(out, `icon-${s}.png`), icon(s));
console.log('built site at repo root');
