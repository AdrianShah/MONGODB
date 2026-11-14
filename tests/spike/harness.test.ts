/**
 * The harness itself: replica set, auth on, pinned version, isolated
 * databases, working applySchema stub, per-user clients.
 */
import { describe, expect, it } from 'vitest';
import { MongoClient, MongoServerError } from 'mongodb';
import {
  ALL_COLLECTIONS,
  DEFAULT_POLICY,
  MissingEnvError,
  applySchema,
  connectWith,
  loadConfig,
  stripCredentials,
} from '@escrowops/shared';
import { createTestDb, testServerUri, useTestDb } from '../helpers/index.js';

const t = useTestDb('harness');

describe('test harness', () => {
  it('runs a replica set (needed for change streams and transactions)', async () => {
    const hello = await t().admin.db('admin').command({ hello: 1 });
    expect(hello['setName']).toBeTruthy();
    expect(hello['isWritablePrimary']).toBe(true);
  });

  it('runs MongoDB 8.0.x', async () => {
    const info = await t().admin.db('admin').command({ buildInfo: 1 });
    expect(String(info['version'])).toMatch(/^8\.0\./);
  });

  it('enforces authentication', async () => {
    const anonymous = new MongoClient(stripCredentials(testServerUri()), { serverSelectionTimeoutMS: 5_000 });
    try {
      await anonymous.connect();
      await expect(anonymous.db(t().dbName).collection('x').findOne({})).rejects.toMatchObject({ code: 13 });
    } finally {
      await anonymous.close();
    }
    await expect(connectWith(testServerUri(), 'nobody', 'wrong', t().dbName)).rejects.toThrow(/Authentication failed/i);
  });

  it('gives each test db a unique name and drops it, with its users, on cleanup', async () => {
    const other = await createTestDb(testServerUri(), 'harness_tmp');
    expect(other.dbName).not.toBe(t().dbName);
    await other.db.collection('probe').insertOne({ ok: 1 });
    const creds = await other.createUser('tmp_reader', [{ role: 'read', db: other.dbName }]);
    const reader = await other.clientAs(creds.username, creds.password);
    expect(await reader.db(other.dbName).collection('probe').countDocuments()).toBe(1);
    await other.cleanup();

    const names = (await t().admin.db('admin').admin().listDatabases()).databases.map((d) => d.name);
    expect(names).not.toContain(other.dbName);
    const users = await t().admin.db(other.dbName).command({ usersInfo: 1 });
    expect(users['users']).toEqual([]);
  });

  it('opens a client as an arbitrary user against the test database', async () => {
    const creds = await t().createUser('harness_rw', [{ role: 'readWrite', db: t().dbName }]);
    const client = await t().clientAs(creds.username, creds.password);
    await client.db(t().dbName).collection('rw').insertOne({ ok: true });
    await expect(client.db(t().dbName).command({ createRole: 'nope', privileges: [], roles: [] })).rejects.toBeInstanceOf(
      MongoServerError,
    );
  });

  it('applySchema creates every collection and is idempotent', async () => {
    const first = await applySchema(t().db, DEFAULT_POLICY);
    expect(first.created).toEqual(expect.arrayContaining(ALL_COLLECTIONS.map((c) => `collection:${c}`)));
    const names = (await t().db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([...ALL_COLLECTIONS]));
    const second = await applySchema(t().db, DEFAULT_POLICY);
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
  });
});

describe('config', () => {
  it('names the missing variable', () => {
    expect(() => loadConfig({})).toThrow(MissingEnvError);
    expect(() => loadConfig({ MONGODB_URI: '  ' })).toThrow(/MONGODB_URI/);
  });

  it('applies defaults and overrides', () => {
    const config = loadConfig({ MONGODB_URI: 'mongodb://h/', AGENT_DB_PASSWORD: 'secret' });
    expect(config.dbName).toBe('escrowops');
    expect(config.roleAuthSource).toBe('escrowops');
    expect(config.users.agent).toEqual({ username: 'escrow_agent', password: 'secret' });
    expect(loadConfig({ MONGODB_URI: 'x', MONGODB_DB: 'd', MONGODB_ROLE_AUTH_SOURCE: 'admin' }).roleAuthSource).toBe('admin');
  });

  it('strips credentials from connection strings', () => {
    expect(stripCredentials('mongodb://u:p@a:1,b:2/?replicaSet=rs&authSource=admin')).toBe(
      'mongodb://a:1,b:2/?replicaSet=rs&authSource=admin',
    );
    expect(stripCredentials('mongodb+srv://u:p%40x@cluster0.example.net/db')).toBe('mongodb+srv://cluster0.example.net/db');
  });
});
