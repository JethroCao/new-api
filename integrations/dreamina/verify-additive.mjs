import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// The reviewed official baseline. Change only when intentionally rebasing the
// additive branch onto a newly reviewed official commit.
export const OFFICIAL_BASELINE = '9c2c370a6156b3ac41874231952a938891ac5483';
const PREFIXES = ['integrations/dreamina/', 'plugins/tasks/dreamina-cli/'];

export function verifyAdditive(root, baseline = OFFICIAL_BASELINE) {
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
  git(['cat-file', '-e', baseline + '^{commit}']);
  const violations = new Set();
  const added = new Set();
  // Check the index separately: a modified official file must not be hidden by
  // restoring only the working copy while leaving a staged change behind.
  for (const args of [[], ['--cached']]) {
    const parts = git(['diff', ...args, '--name-status', '--no-renames', '-z', baseline, '--']).split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const [status, path] = [parts[i], parts[i + 1]];
      if (status !== 'A' || !PREFIXES.some(prefix => path.startsWith(prefix))) violations.add(status + ' ' + path);
      else added.add(path);
    }
  }
  for (const path of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    if (!PREFIXES.some(prefix => path.startsWith(prefix))) violations.add('? ' + path);
    else added.add(path);
  }
  return {baseline, added: [...added].sort(), violations: [...violations].sort()};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const report = verifyAdditive(root);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.violations.length ? 1 : 0;
}
