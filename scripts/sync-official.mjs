// Mirrors The Pandemonium Institute's toolmaker release (https://release.botc.app, source repo
// ThePandemoniumInstitute/botc-release) into public/official/, so the app doesn't depend on that site
// staying up or keeping its URLs. TPI's resources page says toolmakers needing stable URLs should host
// their own copy. Printable PDFs are skipped (large, unused by the app).
//
// Usage: node scripts/sync-official.mjs        (Node 18+)
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'ThePandemoniumInstitute/botc-release';
const SITE = 'https://release.botc.app/';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'official');
const KEEP = [/^resources\/(characters|community|data|editions)\//, /^wc25\//, /^script-schema\.json$/];
const SKIP = [/\.pdf$/i];

const gh = (path) => fetch('https://api.github.com/repos/' + REPO + path, { headers: { 'User-Agent': 'nightfall-sync', Accept: 'application/vnd.github+json' } })
  .then((r) => { if (!r.ok) throw new Error('GitHub API ' + r.status + ' for ' + path); return r.json(); });

const commit = await gh('/commits/main');
const tree = await gh('/git/trees/' + commit.sha + '?recursive=1');
if (tree.truncated) throw new Error('Tree listing truncated; sync would be incomplete.');
const files = tree.tree.filter((e) => e.type === 'blob' && KEEP.some((re) => re.test(e.path)) && !SKIP.some((re) => re.test(e.path)));

await rm(OUT, { recursive: true, force: true });
let bytes = 0, done = 0;
const queue = [...files];
async function worker() {
  for (let f = queue.shift(); f; f = queue.shift()) {
    // Same files are served from release.botc.app; fall back to the raw repo copy.
    let res = await fetch(SITE + f.path);
    if (!res.ok) res = await fetch('https://raw.githubusercontent.com/' + REPO + '/' + commit.sha + '/' + f.path);
    if (!res.ok) throw new Error('Download failed (' + res.status + '): ' + f.path);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(join(OUT, f.path)), { recursive: true });
    await writeFile(join(OUT, f.path), buf);
    bytes += buf.length; done++;
    if (done % 50 === 0) console.log(done + '/' + files.length);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

const manifest = { source: SITE, repo: REPO, commit: commit.sha, syncedAt: new Date().toISOString(), files: files.length, bytes };
await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(OUT, 'NOTICE.md'), `# Official Blood on the Clocktower resources

Everything in this folder (except this notice and \`manifest.json\`) is a copy of
The Pandemonium Institute's toolmaker release, ${SITE} (GitHub: ${REPO}, commit ${commit.sha.slice(0, 7)}).

Blood on the Clocktower, its characters, texts, icons, logos and scripts are © The Pandemonium Institute
and their respective script authors. These files are **not** covered by this project's MIT license.
They are used under TPI's Community Created Content Policy:
https://bloodontheclocktower.com/pages/community-created-content-policy
(non-commercial use; Nightfall is unofficial community content and not affiliated with TPI).

Refresh with \`node scripts/sync-official.mjs\`.
`);
console.log(`Synced ${files.length} files (${(bytes / 1048576).toFixed(1)} MB) from ${REPO}@${commit.sha.slice(0, 7)}`);
