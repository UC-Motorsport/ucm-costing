import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAsset } from './reference-assets.mjs';
import { isPublicSource } from './source-export.mjs';

test('reference acquisition verifies before writing and preserves mismatched existing files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ucm-assets-'));
  const bytes = Buffer.from('synthetic official source');
  const asset = { path: 'source.pdf', url: 'https://example.invalid/source.pdf', sha256: createHash('sha256').update(bytes).digest('hex') };
  try {
    await assert.rejects(prepareAsset(root, asset), /Missing/);
    await assert.rejects(prepareAsset(root, asset, { download: true, fetcher: async () => new Response('wrong') }), /Checksum mismatch/);
    await assert.rejects(readFile(path.join(root, asset.path)), { code: 'ENOENT' });
    assert.equal(await prepareAsset(root, asset, { download: true, fetcher: async () => new Response(bytes) }), 'downloaded');
    assert.equal(await prepareAsset(root, asset), 'verified');
    await writeFile(path.join(root, asset.path), 'preserve me');
    await assert.rejects(prepareAsset(root, asset, { download: true }), /Checksum mismatch/);
    assert.equal(await readFile(path.join(root, asset.path), 'utf8'), 'preserve me');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('public export excludes private assets even if tracked', () => {
  for (const name of ['.git/config', '.env', '.env.production', 'apps/server/.env', 'data/evidence.png', 'backups/db.dump', 'execplans/deployment.md', 'artifacts/screen.png', 'docs/team.csv', 'docs/references/official/rules.pdf', 'docs/references/team/source.xlsx', 'apps/server/assets/ucm-mark.png', 'key.pem', 'apps/web/dist/index.html']) assert.equal(isPublicSource(name), false, name);
  for (const name of ['.env.example', '.github/workflows/ci.yml', 'apps/server/src/app.ts', 'apps/server/test/fixtures/legacy-master.csv', 'docs/references/SOURCES.md', 'LICENSE']) assert.equal(isPublicSource(name), true, name);
});

test('source export copies tracked source only and refuses an existing destination', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdir } = await import('node:fs/promises');
  const { exportSource } = await import('./source-export.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ucm-export-'));
  const repo = path.join(root, 'repo');
  const destination = path.join(root, 'public');
  try {
    await mkdir(repo);
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    await writeFile(path.join(repo, 'README.md'), 'public source');
    await writeFile(path.join(repo, '.env'), 'private placeholder');
    execFileSync('git', ['add', 'README.md', '.env'], { cwd: repo });
    await writeFile(path.join(repo, 'untracked.txt'), 'private untracked file');
    assert.equal(await exportSource(repo, destination), 1);
    assert.equal(await readFile(path.join(destination, 'README.md'), 'utf8'), 'public source');
    for (const name of ['.env', '.git', 'untracked.txt']) await assert.rejects(lstat(path.join(destination, name)), { code: 'ENOENT' });
    await assert.rejects(exportSource(repo, destination), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(destination, 'README.md'), 'utf8'), 'public source');
  } finally { await rm(root, { recursive: true, force: true }); }
});
