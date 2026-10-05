import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A second boundary even if private files are accidentally force-added to Git.
export function isPublicSource(name) {
  if (name.split('/').some(part => part === '..' || part === '.git' || part === '.DS_Store' || (part.startsWith('.env') && part !== '.env.example'))) return false;
  if (/^(artifacts|execplans|data|output|outputs|backups|tmp|node_modules)\//.test(name)) return false;
  if (/^docs\/(design|references\/(team|supporting))\//.test(name)) return false;
  if (/^docs\/.*\.(pdf|xlsx|csv)$/i.test(name)) return false;
  if (/^apps\/server\/assets\/.*\.(png|jpe?g)$/i.test(name)) return false;
  if (/(^|\/)(dist|coverage|node_modules)\//.test(name)) return false;
  if (/\.(pem|key|sqlite3?|dump)$/i.test(name)) return false;
  if (/^EXECPLAN.*\.md$/.test(name) || name === 'design-qa.md') return false;
  return true;
}

export async function exportSource(root, destination) {
  const target = path.resolve(destination);
  if (target === path.resolve(root)) throw new Error('Export requires a new directory');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).filter(isPublicSource);
  // Create exclusively so a typo can never replace an existing checkout.
  await mkdir(target);
  try {
    for (const name of files) {
      const source = path.join(root, name);
      const info = await lstat(source);
      if (!info.isFile()) throw new Error(`Refusing non-regular source: ${name}`);
      const output = path.join(target, name);
      await mkdir(path.dirname(output), { recursive: true });
      await copyFile(source, output);
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return files.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: npm run source:export -- /absolute/new/directory');
    const count = await exportSource(fileURLToPath(new URL('../', import.meta.url)), process.argv[2]);
    console.log(`Exported ${count} source files without Git history. Review the output and THIRD_PARTY_NOTICES.md before publication.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
