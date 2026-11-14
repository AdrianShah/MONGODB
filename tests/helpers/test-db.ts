/**
 * Framework-free core of the test harness: a fresh, uniquely named database
 * on a shared server, plus clients for admin and for arbitrary users.
 * Vitest tests use the `useTestDb()` wrapper in ./index.ts; scripts/spike.ts
 * uses this file directly.
 */
import { randomBytes } from 'node:crypto';
import type { Db, MongoClient } from 'mongodb';
import {
  DEFAULT_USERS,
  connectAdmin,
  connectWith,
  type AppRole,
  type Config,
  type UserCredentials,
} from '@escrowops/shared';

export interface TestDb {
  /** Admin connection string of the shared server. */
  readonly uri: string;
  /** This file's database; unique per createTestDb call. */
  readonly dbName: string;
  /**
   * A Config aimed at this database: pass it to `connectAs(role, config)`,
   * `applySchema`, `applyRoles(admin, dbName)`, `ensureUsers(admin, dbName, config.users)`.
   * Role users authenticate against this database (roleAuthSource = dbName).
   */
  readonly config: Config;
  /** Connected admin client (root). Closed by cleanup(). */
  readonly admin: MongoClient;
  /** `admin.db(dbName)`. */
  readonly db: Db;
  /**
   * Connect as any user. `authSource` defaults to this database, where tests
   * create their users. The client is closed by cleanup().
   */
  clientAs(username: string, password: string, options?: { authSource?: string }): Promise<MongoClient>;
  /** Connect as one of the five process users from `config.users`. Closed by cleanup(). */
  connectAsRole(role: AppRole): Promise<MongoClient>;
  /**
   * Create a user in this database with the given roles (role names in this
   * database, or {role, db} pairs). Returns the credentials. Handy for one-off
   * users; the real five users come from roles.ts `ensureUsers`.
   */
  createUser(username: string, roles: Array<string | { role: string; db: string }>, password?: string): Promise<UserCredentials>;
  /** Drop this database's users, roles and data, and close every client. Safe to call twice. */
  cleanup(): Promise<void>;
}

let counter = 0;

/** Valid, unique, at most 63 bytes: eo_<prefix>_<pid>_<n>_<random>. */
export function uniqueDbName(prefix = 't'): string {
  const safe = prefix.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24);
  counter += 1;
  return `eo_${safe}_${process.pid}_${counter}_${randomBytes(3).toString('hex')}`;
}

export async function createTestDb(uri: string, prefix = 't'): Promise<TestDb> {
  const dbName = uniqueDbName(prefix);
  const config: Config = {
    mongodbUri: uri,
    dbName,
    roleAuthSource: dbName,
    users: structuredClone(DEFAULT_USERS) as Record<AppRole, UserCredentials>,
  };
  const admin = await connectAdmin(config);
  const db = admin.db(dbName);
  const clients = new Set<MongoClient>();
  let cleaned = false;

  const clientAs: TestDb['clientAs'] = async (username, password, options = {}) => {
    const client = await connectWith(uri, username, password, options.authSource ?? dbName, {
      appName: `escrowops-test-${username}`,
    });
    clients.add(client);
    return client;
  };

  return {
    uri,
    dbName,
    config,
    admin,
    db,
    clientAs,
    connectAsRole: (role) => clientAs(config.users[role].username, config.users[role].password),
    async createUser(username, roles, password = `pw-${randomBytes(6).toString('hex')}`) {
      await db.command({ createUser: username, pwd: password, roles });
      return { username, password };
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await Promise.all([...clients].map((c) => c.close().catch(() => undefined)));
      clients.clear();
      for (const command of [{ dropAllUsersFromDatabase: 1 }, { dropAllRolesFromDatabase: 1 }]) {
        await db.command(command).catch(() => undefined);
      }
      await db.dropDatabase().catch(() => undefined);
      await admin.close().catch(() => undefined);
    },
  };
}
