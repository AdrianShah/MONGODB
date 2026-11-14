/**
 * O5: with MONGODB_URI unset, `npm run seed` and `npm run reset` exit
 * non-zero with a message naming the variable.
 *
 * The scripts run in a child process from an empty temp directory, so no
 * `.env` is picked up (dotenv reads from the working directory).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const emptyDir = mkdtempSync(join(tmpdir(), 'eo-ops-'));

afterAll(() => {
  rmSync(emptyDir, { recursive: true, force: true });
});

function runScript(script: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env['MONGODB_URI'];
  if ('MONGODB_URI' in extraEnv) env['MONGODB_URI'] = extraEnv['MONGODB_URI'];
  return spawnSync(process.execPath, [tsxCli, join(repoRoot, 'scripts', script)], {
    cwd: emptyDir,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('scripts without MONGODB_URI (O5)', () => {
  for (const script of ['seed.ts', 'reset.ts']) {
    it(`${script} exits non-zero and names the variable when it is unset`, () => {
      const result = runScript(script);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('MONGODB_URI');
    });

    it(`${script} treats an empty MONGODB_URI as missing`, () => {
      const result = runScript(script, { MONGODB_URI: '   ' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('MONGODB_URI');
    });
  }
});
