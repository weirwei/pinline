// Render icons/icon.svg to icons/icon-{16,32,48,128}.png with headless Chrome (transparent background).
// 128 keeps the 16 px store padding; the small toolbar sizes crop most of it so the artwork stays legible.
// Usage: CHROME_HEADLESS=/path/to/chrome-headless-shell node scripts/icons.mjs
// (chrome-headless-shell exits after the screenshot; full Chrome with --headless may keep running.)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_HEADLESS || process.env.CHROME_BIN;
if (!CHROME) {
  console.error('Set CHROME_HEADLESS to a chrome-headless-shell binary.');
  process.exit(2);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const svg = readFileSync(join(root, 'icons/icon.svg'), 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'icons-'));
try {
  for (const size of [16, 32, 48, 128]) {
    const viewBox = size === 128 ? '0 0 128 128' : '14 14 100 100';
    const sized = svg.replace(/viewBox="[^"]*"/, `viewBox="${viewBox}" width="${size}" height="${size}"`);
    const html = join(tmp, `${size}.html`);
    writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);
    const out = join(root, `icons/icon-${size}.png`);
    execFileSync(CHROME, [
      '--headless', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(tmp, 'profile')}`,
      `--window-size=${size},${size}`, '--default-background-color=00000000', `--screenshot=${out}`, `file://${html}`,
    ], { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
    console.log(`icons/icon-${size}.png`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
