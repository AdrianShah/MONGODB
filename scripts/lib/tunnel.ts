/**
 * Safety checks for `npm run demo:tunnel`. A tunnel puts the dashboard on a public URL, and
 * the repo (with the dev approver passwords in it) is public, so the tunnel refuses to start
 * unless real approver passwords are set and the board still needs a sign-in.
 */
import { DEFAULT_APPROVERS, InvalidApproversError, loadApprovers } from '@escrowops/api';
import type { Env } from '@escrowops/shared';

export const MIN_TUNNEL_PASSWORD = 12;

/** Reasons the tunnel must not start; empty means it is safe to open. */
export function tunnelProblems(env: Env): string[] {
  const problems: string[] = [];
  if (!env['APPROVERS']?.trim()) {
    problems.push(
      'APPROVERS is not set, so anyone could sign in with the dev passwords published in this repo. ' +
        'Set APPROVERS="approver-a:<password>,approver-b:<password>" in .env and restart npm run services.',
    );
  } else {
    try {
      const devPasswords = new Set(DEFAULT_APPROVERS.map((a) => a.password));
      for (const a of loadApprovers(env)) {
        if (devPasswords.has(a.password)) problems.push(`approver ${a.id} uses a dev password from this repo`);
        else if (a.password.length < MIN_TUNNEL_PASSWORD) {
          problems.push(`approver ${a.id} has a password shorter than ${MIN_TUNNEL_PASSWORD} characters`);
        }
      }
    } catch (err) {
      if (!(err instanceof InvalidApproversError)) throw err;
      problems.push(err.message);
    }
  }
  if (['1', 'true', 'yes'].includes((env['DASHBOARD_PUBLIC'] ?? '').toLowerCase())) {
    problems.push('DASHBOARD_PUBLIC is set, so the board would be visible without signing in. Unset it.');
  }
  return problems;
}

/** The public URL in cloudflared's log output, once it has printed one. */
export function findTunnelUrl(output: string): string | undefined {
  return output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
}
