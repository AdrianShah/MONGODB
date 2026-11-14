/**
 * ROLE_DEFINITIONS invariants (PRD section 7), applyRoles / ensureUsers
 * idempotency (O1 for the access half of `npm run setup`), drift repair, and
 * the Atlas role generator.
 */
import { describe, expect, it } from 'vitest';
import {
  APPEND_ONLY_COLLECTIONS,
  APP_ROLES,
  COLLECTIONS,
  FORBIDDEN_RUNTIME_ACTIONS,
  ROLE_DEFINITIONS,
  ROLE_NAMES,
  RUNTIME_ROLES,
  applyRoles,
  applySchema,
  ensureUsers,
  roleDefinition,
} from '@escrowops/shared';
import { ERROR_CODES, expectServerError, useTestDb } from '../helpers/index.js';
import { atlasCliCommands, atlasCustomRoles, toAtlasAction } from '../../scripts/atlas-roles.js';

const t = useTestDb('roles_setup');

describe('ROLE_DEFINITIONS', () => {
  it('defines exactly one role per ROLE_NAMES entry', () => {
    expect(ROLE_DEFINITIONS.map((d) => d.role).sort()).toEqual(Object.values(ROLE_NAMES).sort());
  });

  it('no runtime role has update or remove on append-only collections', () => {
    for (const role of RUNTIME_ROLES) {
      for (const p of roleDefinition(role).privileges) {
        if (p.collection === '' || APPEND_ONLY_COLLECTIONS.includes(p.collection)) {
          expect(p.actions, `${role} on "${p.collection}"`).not.toContain('update');
          expect(p.actions, `${role} on "${p.collection}"`).not.toContain('remove');
        }
      }
    }
  });

  it('no runtime role has collMod, bypassDocumentValidation or management actions; no role bypasses validation', () => {
    for (const role of RUNTIME_ROLES) {
      const actions = roleDefinition(role).privileges.flatMap((p) => p.actions);
      for (const forbidden of FORBIDDEN_RUNTIME_ACTIONS) expect(actions, role).not.toContain(forbidden);
    }
    for (const role of APP_ROLES) {
      expect(roleDefinition(role).privileges.flatMap((p) => p.actions), role).not.toContain('bypassDocumentValidation');
    }
  });

  it('every changeStream grant comes with find (SPIKE.md c)', () => {
    for (const def of ROLE_DEFINITIONS) {
      for (const p of def.privileges) {
        if (p.actions.includes('changeStream')) expect(p.actions, def.role).toContain('find');
      }
    }
  });

  it('the agent cannot write anywhere but agent_traces, intents and review_queue', () => {
    const writable = roleDefinition('agent')
      .privileges.filter((p) => p.actions.some((a) => a !== 'find'))
      .map((p) => p.collection)
      .sort();
    expect(writable).toEqual([COLLECTIONS.agent_traces, COLLECTIONS.intents, COLLECTIONS.review_queue].sort());
  });
});

describe('applyRoles + ensureUsers', () => {
  it('create everything on the first run and change nothing on the second', async () => {
    await applySchema(t().db);
    const roles1 = await applyRoles(t().admin, t().dbName);
    const users1 = await ensureUsers(t().admin, t().dbName, t().config.users);
    expect(roles1.created.sort()).toEqual(Object.values(ROLE_NAMES).map((r) => `role:${r}`).sort());
    expect(users1.created).toHaveLength(APP_ROLES.length);

    const roles2 = await applyRoles(t().admin, t().dbName);
    const users2 = await ensureUsers(t().admin, t().dbName, t().config.users);
    expect(roles2.created).toEqual([]);
    expect(roles2.updated).toEqual([]);
    expect(roles2.unchanged).toHaveLength(ROLE_DEFINITIONS.length);
    expect(users2.created).toEqual([]);
    expect(users2.updated).toEqual([]);
    expect(users2.unchanged).toHaveLength(APP_ROLES.length);
  });

  it('every user can log in and holds exactly its own role', async () => {
    for (const role of APP_ROLES) {
      const client = await t().connectAsRole(role);
      const status = await client.db(t().dbName).command({ connectionStatus: 1 });
      const held = (status['authInfo']['authenticatedUserRoles'] as Array<{ role: string; db: string }>).map((r) => `${r.role}@${r.db}`);
      expect(held).toEqual([`${ROLE_NAMES[role]}@${t().dbName}`]);
    }
  });

  it('repairs a role whose privileges drifted, and the agent is locked down again', async () => {
    await t().db.command({
      grantPrivilegesToRole: ROLE_NAMES.agent,
      privileges: [{ resource: { db: t().dbName, collection: COLLECTIONS.intents }, actions: ['remove', 'update'] }],
    });
    await t().db.command({ grantRolesToRole: ROLE_NAMES.agent, roles: [{ role: 'read', db: t().dbName }] });

    const repaired = await applyRoles(t().admin, t().dbName);
    expect(repaired.updated).toEqual([`role:${ROLE_NAMES.agent}`]);
    expect((await applyRoles(t().admin, t().dbName)).updated).toEqual([]);

    const agent = (await t().connectAsRole('agent')).db(t().dbName);
    await expectServerError(() => agent.collection(COLLECTIONS.intents).deleteMany({}), ERROR_CODES.UNAUTHORIZED);
    await expectServerError(() => agent.collection(COLLECTIONS.executor_state).findOne({}), ERROR_CODES.UNAUTHORIZED);
  });

  it('repairs a user whose roles or password drifted', async () => {
    const { username } = t().config.users.agent;
    await t().db.command({ grantRolesToUser: username, roles: [{ role: 'readWrite', db: t().dbName }] });
    const changed = { ...t().config.users, agent: { username, password: 'rotated-agent-password' } };

    const repaired = await ensureUsers(t().admin, t().dbName, changed);
    expect(repaired.updated).toEqual([`user:${username}`]);
    expect((await ensureUsers(t().admin, t().dbName, changed)).updated).toEqual([]);

    const client = await t().clientAs(username, 'rotated-agent-password');
    await expectServerError(() => client.db(t().dbName).collection(COLLECTIONS.ledger).insertOne({ x: 1 }), ERROR_CODES.UNAUTHORIZED);
    await expect(t().clientAs(username, t().config.users.agent.password)).rejects.toThrow(/Authentication failed/i);

    // Put the configured password back for any later test.
    await ensureUsers(t().admin, t().dbName, t().config.users);
  });
});

describe('Atlas role generator (scripts/atlas-roles.ts)', () => {
  it('maps server action names to Atlas names', () => {
    expect(toAtlasAction('find')).toBe('FIND');
    expect(toAtlasAction('changeStream')).toBe('CHANGE_STREAM');
    expect(toAtlasAction('collMod')).toBe('COLL_MOD');
    expect(toAtlasAction('listCollections')).toBe('LIST_COLLECTIONS');
  });

  it('emits all five roles from ROLE_DEFINITIONS with the same privileges', () => {
    const roles = atlasCustomRoles('escrowops');
    expect(roles.map((r) => r.roleName).sort()).toEqual(Object.values(ROLE_NAMES).sort());
    for (const def of ROLE_DEFINITIONS) {
      const atlas = roles.find((r) => r.roleName === def.role);
      const expected = def.privileges.flatMap((p) => p.actions.map((a) => `${toAtlasAction(a)}@escrowops.${p.collection}`)).sort();
      const actual = (atlas?.actions ?? []).flatMap((a) => a.resources.map((r) => `${a.action}@${r.db}.${r.collection}`)).sort();
      expect(actual, def.role).toEqual(expected);
      expect(atlas?.inheritedRoles).toEqual([]);
    }
    expect(atlasCliCommands('escrowops')).toHaveLength(ROLE_DEFINITIONS.length);
  });
});
