/**
 * Starts (or points at) the one MongoDB server a test run uses.
 *
 * - MONGODB_URI set: use that server. The URI must carry admin credentials
 *   (a user that can create databases, roles and users).
 * - MONGODB_URI unset: start a single-node `MongoMemoryReplSet` with auth
 *   enabled (keyfile + root user). Replica set is required for Change
 *   Streams and transactions; auth is required for every role test.
 *   The mongod version is pinned in package.json
 *   ("config.mongodbMemoryServer.version"); the first run downloads it.
 *
 * Used by tests/helpers/global-setup.ts (once per `npm test`) and by
 * scripts/spike.ts.
 */
import { readFileSync } from 'node:fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

export const TEST_ROOT_USER = 'escrowops_root';
export const TEST_ROOT_PASSWORD = 'root-dev-password';

export interface TestServer {
  /** Admin connection string, credentials included. */
  uri: string;
  /** "memory" when this process started the server, "external" for MONGODB_URI. */
  kind: 'memory' | 'external';
  stop(): Promise<void>;
}

function pinnedMongodVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    config?: { mongodbMemoryServer?: { version?: string } };
  };
  const version = pkg.config?.mongodbMemoryServer?.version;
  if (!version) throw new Error('package.json is missing config.mongodbMemoryServer.version');
  return version;
}

/** Insert credentials and authSource=admin into a mongodb:// URI from MongoMemoryReplSet. */
function withRootCredentials(uri: string): string {
  const withUser = uri.replace(
    /^mongodb:\/\//,
    `mongodb://${encodeURIComponent(TEST_ROOT_USER)}:${encodeURIComponent(TEST_ROOT_PASSWORD)}@`,
  );
  return withUser + (withUser.includes('?') ? '&' : '?') + 'authSource=admin';
}

export async function startTestServer(env: NodeJS.ProcessEnv = process.env): Promise<TestServer> {
  const external = env['MONGODB_URI']?.trim();
  if (external) {
    return { uri: external, kind: 'external', stop: async () => undefined };
  }

  const replSet = await MongoMemoryReplSet.create({
    binary: { version: pinnedMongodVersion() },
    replSet: {
      count: 1,
      name: 'escrowops-rs',
      storageEngine: 'wiredTiger',
      auth: {
        enable: true,
        customRootName: TEST_ROOT_USER,
        customRootPwd: TEST_ROOT_PASSWORD,
      },
    },
  });
  await replSet.waitUntilRunning();

  return {
    uri: withRootCredentials(replSet.getUri()),
    kind: 'memory',
    stop: async () => {
      await replSet.stop({ doCleanup: true, force: true });
    },
  };
}
