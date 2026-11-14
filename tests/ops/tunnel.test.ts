/** `npm run demo:tunnel` refuses to open a public link with guessable sign-ins or a public board. */
import { describe, expect, it } from 'vitest';
import { findTunnelUrl, tunnelProblems } from '../../scripts/lib/tunnel.js';

const strong = 'approver-a:correct-horse-battery,approver-b:staple-gun-orange-sky';

describe('tunnel safety', () => {
  it('refuses when APPROVERS is unset (dev passwords are public)', () => {
    expect(tunnelProblems({}).join(' ')).toMatch(/APPROVERS is not set/);
  });

  it('refuses the dev passwords even when spelled out in APPROVERS', () => {
    const problems = tunnelProblems({ APPROVERS: 'approver-a:approver-a-dev-password,approver-b:staple-gun-orange-sky' });
    expect(problems).toEqual(['approver approver-a uses a dev password from this repo']);
  });

  it('refuses short passwords and malformed APPROVERS', () => {
    expect(tunnelProblems({ APPROVERS: 'approver-a:short,approver-b:staple-gun-orange-sky' })[0]).toMatch(/shorter than 12/);
    expect(tunnelProblems({ APPROVERS: 'nocolon' })[0]).toMatch(/must look like/);
  });

  it('refuses DASHBOARD_PUBLIC', () => {
    expect(tunnelProblems({ APPROVERS: strong, DASHBOARD_PUBLIC: '1' })[0]).toMatch(/DASHBOARD_PUBLIC/);
  });

  it('allows strong passwords with sign-in required', () => {
    expect(tunnelProblems({ APPROVERS: strong })).toEqual([]);
  });

  it('finds the quick-tunnel URL in cloudflared output', () => {
    const log = '2026-11-14T10:00:00Z INF |  https://brave-otter-lake-sun.trycloudflare.com                |';
    expect(findTunnelUrl(log)).toBe('https://brave-otter-lake-sun.trycloudflare.com');
    expect(findTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeUndefined();
  });
});
