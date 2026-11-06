// Build the Chrome Web Store upload: manifest.json without `key` (the store rejects it), src/ and the PNG icons.
// The local `key` only pins the unpacked dev build's id; the store assigns its own.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
delete manifest.key;

const out = join(root, `${name}.zip`);
const stage = mkdtempSync(join(tmpdir(), `${name}-zip-`));
try {
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const skip = (src) => !/\.DS_Store$/.test(src);
  cpSync(join(root, 'src'), join(stage, 'src'), { recursive: true, filter: skip });
  cpSync(join(root, 'icons'), join(stage, 'icons'), { recursive: true, filter: (src) => skip(src) && !src.endsWith('.svg') });
  rmSync(out, { force: true });
  execFileSync('zip', ['-qr', out, 'manifest.json', 'src', 'icons'], { cwd: stage });
  console.log(`${name}.zip (manifest without "key", version ${manifest.version})`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
