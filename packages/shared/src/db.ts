/**
 * Connection helpers. Every process connects as exactly one database user.
 *
 *   const config = loadConfigOrExit();
 *   const client = await connectAs('agent', config);
 *   const db = client.db(config.dbName);
 *
 * `connectAdmin(config)` connects with the credentials embedded in
 * MONGODB_URI and is only for setup, seed, reset and tests.
 *
 * Every helper returns an already-connected MongoClient; the caller closes it.
 */
import { MongoClient, type MongoClientOptions } from 'mongodb';
import { loadConfigOrExit, type Config } from './config.js';
import { ROLE_NAMES, type AppRole } from './roles.js';

const SCHEME_AND_CREDENTIALS = /^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?/i;

/** Remove `user:pass@` from a connection string, keeping hosts and options. */
export function stripCredentials(uri: string): string {
  return uri.replace(SCHEME_AND_CREDENTIALS, '$1');
}

/**
 * Connect to the server in `uri` as an arbitrary user. Any credentials already
 * in `uri` are dropped. `authSource` is the database the user was created in.
 */
export async function connectWith(
  uri: string,
  username: string,
  password: string,
  authSource: string,
  options: MongoClientOptions = {},
): Promise<MongoClient> {
  const client = new MongoClient(stripCredentials(uri), {
    ...options,
    auth: { username, password },
    authSource,
  });
  try {
    await client.connect();
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
  return client;
}

/** Connect as the database user for one process identity (PRD section 7). */
export async function connectAs(
  role: AppRole,
  config: Config = loadConfigOrExit(),
  options: MongoClientOptions = {},
): Promise<MongoClient> {
  const { username, password } = config.users[role];
  return connectWith(config.mongodbUri, username, password, config.roleAuthSource, {
    appName: `escrowops-${ROLE_NAMES[role]}`,
    ...options,
  });
}

/** Connect with the admin credentials embedded in MONGODB_URI. */
export async function connectAdmin(
  config: Config = loadConfigOrExit(),
  options: MongoClientOptions = {},
): Promise<MongoClient> {
  const client = new MongoClient(config.mongodbUri, { appName: 'escrowops-admin', ...options });
  try {
    await client.connect();
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
  return client;
}
