import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const referenceAssets = [
  { path: 'docs/Local Addendum 2026 Version 1.2 (1).pdf', url: 'https://www.sme-a.org/client_images/5276665.pdf', sha256: '4eee1b95f3c9b11d4a4b93bdcdedfd3273d9ae55278d1bd35afa238102c1b8d9' },
  { path: 'docs/references/official/FSAE-A_2026_Local_Addendum_v1.4.pdf', url: 'https://www.sme-a.org/client_images/5832409.pdf', sha256: '1cfd33c17bcf8c7621283b3592633f816c29b0fa60bfc8eab9c1b5eaa9fc6688' },
  { path: 'docs/references/official/FSAE-A_Cost_Catalogue_2026_v1.0.xlsx', url: 'https://www.sme-a.org/client_images/5102753.xlsx', sha256: '392e6a0b4729df6fe43e57af9846859758195f5a80ba926c1a3756824892e070' },
];

function verify(bytes, asset) {
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error(`Checksum mismatch: ${asset.path}. Keep the pinned version; do not replace it with a newer upstream revision.`);
  }
}

export async function prepareAsset(root, asset, { download = false, fetcher = fetch } = {}) {
  const destination = path.resolve(root, asset.path);
  if (!destination.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid asset path');
  try {
    verify(await readFile(destination), asset);
    return 'verified';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!download) throw new Error(`Missing ${asset.path}; run npm run references:fetch or obtain the exact file from its owner.`);
  const response = await fetcher(asset.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${asset.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verify(bytes, asset);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await link(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return 'downloaded';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['--fetch', '--check'].includes(mode) || process.argv.length !== 3) {
    console.error('Usage: node scripts/reference-assets.mjs --fetch|--check');
    process.exitCode = 1;
  } else {
    try {
      const root = fileURLToPath(new URL('../', import.meta.url));
      for (const asset of referenceAssets) console.log(`${await prepareAsset(root, asset, { download: mode === '--fetch' })}: ${asset.path}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
