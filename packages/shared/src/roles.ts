/**
 * Database roles and users (PRD section 7, "Roles").
 *
 * OWNER: Wave 1 Agent B (access).
 *
 * Contract (keep stable, other modules import these):
 * - `ROLE_NAMES`, `AppRole`, `APP_ROLES`: the five process identities and the
 *   server-side role name each one uses. config.ts and db.ts depend on them.
 * - `RoleDefinition` / `Privilege`: one role as a list of {collection, actions}.
 * - `ROLE_DEFINITIONS`: the single source of truth for every privilege. The
 *   local `createRole` path (applyRoles) and the Atlas generator
 *   (scripts/atlas-roles.ts) both read it.
 * - `applyRoles(adminClient, dbName)`: create or update every role in
 *   `ROLE_DEFINITIONS` on database `dbName`. Idempotent.
 * - `ensureUsers(adminClient, dbName, users?)`: create or update one user per
 *   role, granted that role, with credentials from config (or `users`).
 *   Idempotent.
 *
 * Where roles and users live: by default both are created in the application
 * database itself (`dbName`), so each test file's unique database carries its
 * own roles and users and nothing leaks between files. Role users then
 * authenticate with `authSource = dbName`, which is what `connectAs` does by
 * default (see `Config.roleAuthSource`). On Atlas, roles and users are
 * managed through the Atlas UI/CLI/Admin API instead (docs/ATLAS_SETUP.md);
 * there `createRole` is refused and applyRoles throws
 * `RoleManagementRefusedError`.
 *
 * Least privilege rules this file is held to (tests/roles/definitions.test.ts):
 * - No runtime role (agent, approver, executor, dashboard) has `update` or
 *   `remove` on intents, approved, approvals or agent_traces (append-only).
 * - No role at all has `bypassDocumentValidation`; no runtime role has
 *   `collMod` or any index or collection management action.
 * - A Change Stream watcher needs BOTH `find` and `changeStream` (SPIKE.md c).
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { MongoServerError, type Document, type MongoClient } from 'mongodb';
import { COLLECTIONS as C, type CollectionName } from './collections.js';
import { loadConfig } from './config.js';
import { emptyChangeSummary, type ChangeSummary } from './types.js';

export const ROLE_NAMES = {
  agent: 'agent_role',
  approver: 'approver_role',
  executor: 'executor_role',
  dashboard: 'dashboard_role',
  admin: 'admin_role',
} as const;

/** A process identity: which database user a process connects as. */
export type AppRole = keyof typeof ROLE_NAMES;

export const APP_ROLES: readonly AppRole[] = Object.keys(ROLE_NAMES) as AppRole[];

/** Roles held by long-running processes. `admin` is only used by setup scripts. */
export const RUNTIME_ROLES: readonly AppRole[] = ['agent', 'approver', 'executor', 'dashboard'];

/** Server action names, e.g. "find", "insert", "update", "remove", "changeStream", "collMod". */
export type PrivilegeAction = string;

export interface Privilege {
  /** A collection name, or "" for every collection in the database. */
  collection: CollectionName | '';
  actions: PrivilegeAction[];
}

export interface RoleDefinition {
  role: (typeof ROLE_NAMES)[AppRole];
  privileges: Privilege[];
}

/** Collections that are append-only for every runtime role. */
export const APPEND_ONLY_COLLECTIONS: readonly CollectionName[] = [C.intents, C.approved, C.approvals, C.agent_traces];

/** Actions no runtime role may hold on any resource. */
export const FORBIDDEN_RUNTIME_ACTIONS: readonly PrivilegeAction[] = [
  'collMod',
  'bypassDocumentValidation',
  'createIndex',
  'dropIndex',
  'createCollection',
  'dropCollection',
  'dropDatabase',
  'convertToCapped',
  'renameCollectionSameDB',
  'createRole',
  'grantRole',
  'createUser',
];

/** A Change Stream needs find + changeStream on the watched resource (SPIKE.md c). */
const WATCH = ['find', 'changeStream'];

/**
 * One entry per role in ROLE_NAMES, exactly the PRD section 7 role table.
 * Order of privileges and actions does not matter to the server.
 */
export const ROLE_DEFINITIONS: readonly RoleDefinition[] = Object.freeze([
  {
    // Reads source data, appends proposals and traces. Nothing else.
    role: ROLE_NAMES.agent,
    privileges: [
      { collection: C.tickets, actions: ['find'] },
      { collection: C.orders, actions: ['find'] },
      { collection: C.customers, actions: ['find'] },
      { collection: C.policies, actions: ['find'] },
      { collection: C.agent_traces, actions: ['insert'] },
      { collection: C.intents, actions: ['insert'] },
      { collection: C.review_queue, actions: ['insert'] },
    ],
  },
  {
    // Approval service: watches and updates the review queue, records
    // decisions, and promotes a fully approved review in one transaction
    // (insert approvals + insert approved + update review_queue).
    role: ROLE_NAMES.approver,
    privileges: [
      { collection: C.review_queue, actions: [...WATCH, 'update'] },
      { collection: C.approvals, actions: ['find', 'insert'] },
      { collection: C.approved, actions: ['insert'] },
    ],
  },
  {
    // Executor: watches the two trusted collections, owns its own state.
    role: ROLE_NAMES.executor,
    privileges: [
      { collection: C.intents, actions: [...WATCH] },
      { collection: C.approved, actions: [...WATCH] },
      { collection: C.ledger, actions: ['find', 'insert', 'update'] },
      { collection: C.budgets, actions: ['find', 'insert', 'update'] },
      { collection: C.executor_state, actions: ['find', 'insert', 'update'] },
      { collection: C.orders, actions: ['find'] },
    ],
  },
  {
    // Dashboard: read and watch everything (database-wide resource), no writes.
    role: ROLE_NAMES.dashboard,
    privileges: [{ collection: '', actions: [...WATCH] }],
  },
  {
    // Setup scripts: collections, validators (collMod), indexes, policies.
    // No user/role management, no bypassDocumentValidation, no drops of data.
    role: ROLE_NAMES.admin,
    privileges: [
      {
        collection: '',
        actions: ['listCollections', 'createCollection', 'collMod', 'listIndexes', 'createIndex', 'dropIndex'],
      },
      { collection: C.policies, actions: ['find', 'insert', 'update'] },
    ],
  },
] satisfies RoleDefinition[]);

export function roleDefinition(role: AppRole): RoleDefinition {
  const def = ROLE_DEFINITIONS.find((d) => d.role === ROLE_NAMES[role]);
  if (!def) throw new Error(`No role definition for ${role}`);
  return def;
}

export interface UserCredentials {
  username: string;
  password: string;
}

/**
 * Thrown when the server refuses role or user management. On Atlas this is
 * expected: custom roles and database users are managed through the Atlas
 * control plane (docs/ATLAS_SETUP.md), not `createRole` / `createUser`.
 */
export class RoleManagementRefusedError extends Error {
  /** True when the refusal looks like Atlas (AtlasError, code 8000, or an Atlas message). */
  readonly atlas: boolean;
  readonly command: string;
  override readonly cause: MongoServerError;
  constructor(command: string, cause: MongoServerError) {
    const atlas = isAtlasRefusal(cause);
    super(
      atlas
        ? `The server refused ${command}: on Atlas, custom roles and database users are managed through the Atlas UI, CLI or Admin API. See docs/ATLAS_SETUP.md. (server said: code ${String(cause.code)} ${firstLine(cause.message)})`
        : `The server refused ${command} (code ${String(cause.code)}): the MONGODB_URI user cannot manage roles and users on this database. Use a user with userAdmin (or root) on it. (server said: ${firstLine(cause.message)})`,
    );
    this.name = 'RoleManagementRefusedError';
    this.atlas = atlas;
    this.command = command;
    this.cause = cause;
  }
}

function firstLine(message: string): string {
  const line = message.split('\n')[0] ?? message;
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function isAtlasRefusal(err: MongoServerError): boolean {
  return err.code === 8000 || err.codeName === 'AtlasError' || /atlas|CMD_NOT_ALLOWED/i.test(err.message);
}

/** Codes that mean "you may not manage roles/users here", rather than a bug in the request. */
function isManagementRefusal(err: unknown): err is MongoServerError {
  return (
    err instanceof MongoServerError &&
    (err.code === 13 || err.code === 8000 || err.codeName === 'AtlasError' || /CMD_NOT_ALLOWED|not allowed/i.test(err.message))
  );
}

async function runManagement(adminClient: MongoClient, dbName: string, command: Document): Promise<Document> {
  try {
    return await adminClient.db(dbName).command(command);
  } catch (err) {
    if (isManagementRefusal(err)) throw new RoleManagementRefusedError(Object.keys(command)[0] ?? 'command', err);
    throw err;
  }
}

/** The privileges a role definition expands to on `dbName`, in server shape. */
export function serverPrivileges(def: RoleDefinition, dbName: string): Array<{ resource: { db: string; collection: string }; actions: string[] }> {
  return def.privileges.map((p) => ({ resource: { db: dbName, collection: p.collection }, actions: [...p.actions] }));
}

/** Canonical form for comparing privileges: merged per resource, actions sorted. */
function canonicalPrivileges(privileges: Document[]): string {
  const byResource = new Map<string, Set<string>>();
  for (const p of privileges) {
    const resource = (p['resource'] ?? {}) as Document;
    const key = JSON.stringify(
      'cluster' in resource ? { cluster: resource['cluster'] } : { db: resource['db'] ?? null, collection: resource['collection'] ?? null },
    );
    const set = byResource.get(key) ?? new Set<string>();
    for (const action of (p['actions'] ?? []) as string[]) set.add(action);
    byResource.set(key, set);
  }
  return JSON.stringify([...byResource.entries()].map(([k, v]) => [k, [...v].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** Create or update every role in ROLE_DEFINITIONS on `dbName`. */
export async function applyRoles(adminClient: MongoClient, dbName: string): Promise<ChangeSummary> {
  const summary = emptyChangeSummary();
  const info = await runManagement(adminClient, dbName, {
    rolesInfo: ROLE_DEFINITIONS.map((d) => ({ role: d.role, db: dbName })),
    showPrivileges: true,
  });
  const existing = new Map<string, Document>();
  for (const r of (info['roles'] ?? []) as Document[]) existing.set(String(r['role']), r);

  for (const def of ROLE_DEFINITIONS) {
    const tag = `role:${def.role}`;
    const privileges = serverPrivileges(def, dbName);
    const current = existing.get(def.role);
    if (!current) {
      await runManagement(adminClient, dbName, { createRole: def.role, privileges, roles: [] });
      summary.created.push(tag);
      continue;
    }
    const inherited = (current['roles'] ?? []) as Document[];
    const same =
      inherited.length === 0 && canonicalPrivileges((current['privileges'] ?? []) as Document[]) === canonicalPrivileges(privileges);
    if (same) {
      summary.unchanged.push(tag);
    } else {
      // updateRole replaces privileges and inherited roles wholesale.
      await runManagement(adminClient, dbName, { updateRole: def.role, privileges, roles: [] });
      summary.updated.push(tag);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * The server never returns a password, so to notice a changed password in
 * config, ensureUsers stores a salted scrypt check value in the user's
 * customData and compares against it on the next run.
 */
const PWD_CHECK_FIELD = 'escrowops_pwd_check';

function passwordCheck(username: string, password: string, salt = randomBytes(16)): string {
  const hash = scryptSync(`${username}\0${password}`, salt, 32);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function passwordMatches(stored: unknown, username: string, password: string): boolean {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(`${username}\0${password}`, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Create or update one user per AppRole on `dbName`, granted ROLE_NAMES[role]
 * (and nothing else). `users` defaults to the credentials in config
 * (loadConfig().users). A user whose roles or password drifted is updated.
 */
export async function ensureUsers(
  adminClient: MongoClient,
  dbName: string,
  users?: Record<AppRole, UserCredentials>,
): Promise<ChangeSummary> {
  const creds = users ?? loadConfig().users;
  const summary = emptyChangeSummary();

  const info = await runManagement(adminClient, dbName, {
    usersInfo: APP_ROLES.map((r) => ({ user: creds[r].username, db: dbName })),
  });
  const existing = new Map<string, Document>();
  for (const u of (info['users'] ?? []) as Document[]) existing.set(String(u['user']), u);

  for (const role of APP_ROLES) {
    const { username, password } = creds[role];
    const tag = `user:${username}`;
    const roles = [{ role: ROLE_NAMES[role], db: dbName }];
    const current = existing.get(username);
    if (!current) {
      await runManagement(adminClient, dbName, {
        createUser: username,
        pwd: password,
        roles,
        customData: { escrowops_role: role, [PWD_CHECK_FIELD]: passwordCheck(username, password) },
      });
      summary.created.push(tag);
      continue;
    }

    const currentRoles = ((current['roles'] ?? []) as Document[]).map((r) => `${String(r['role'])}@${String(r['db'])}`);
    const rolesOk = currentRoles.length === 1 && currentRoles[0] === `${ROLE_NAMES[role]}@${dbName}`;
    const customData = (current['customData'] ?? {}) as Document;
    const passwordOk = passwordMatches(customData[PWD_CHECK_FIELD], username, password);
    const roleTagOk = customData['escrowops_role'] === role;
    if (rolesOk && passwordOk && roleTagOk) {
      summary.unchanged.push(tag);
      continue;
    }
    const update: Document = { updateUser: username, roles };
    if (!passwordOk) update['pwd'] = password;
    update['customData'] = {
      ...customData,
      escrowops_role: role,
      [PWD_CHECK_FIELD]: passwordOk ? customData[PWD_CHECK_FIELD] : passwordCheck(username, password),
    };
    await runManagement(adminClient, dbName, update);
    summary.updated.push(tag);
  }
  return summary;
}
