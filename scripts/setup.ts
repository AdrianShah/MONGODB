/**
 * npm run setup (PRD T1, TEST_PLAN O1)
 *
 * Connects with the admin credentials in MONGODB_URI and makes the database
 * match the code: collections, validators and indexes (applySchema), the five
 * roles (applyRoles) and the five users (ensureUsers). Prints what changed.
 * Safe to re-run: a second run on an unchanged database reports no changes.
 *
 * Exit codes:
 *   0  done (or nothing to do)
 *   1  could not connect, or an unexpected error
 *   2  schema applied, but the server refused role/user management. On Atlas
 *      this is expected: create the roles and users through the Atlas
 *      control plane (docs/ATLAS_SETUP.md), then re-run.
 */
import {
  APP_ROLES,
  ROLE_NAMES,
  RoleManagementRefusedError,
  applyRoles,
  applySchema,
  connectAdmin,
  connectAs,
  embeddingConfig,
  ensureUsers,
  ensureVectorIndex,
  hasChanges,
  loadConfigOrExit,
  stripCredentials,
  type ChangeSummary,
} from '@escrowops/shared';
import type { MongoClient } from 'mongodb';

function report(title: string, summary: ChangeSummary): void {
  if (!hasChanges(summary)) {
    console.log(`${title}: no changes (${summary.unchanged.length} up to date)`);
    return;
  }
  console.log(`${title}:`);
  for (const item of summary.created) console.log(`  + created  ${item}`);
  for (const item of summary.updated) console.log(`  ~ updated  ${item}`);
  if (summary.unchanged.length > 0) console.log(`  = ${summary.unchanged.length} already up to date`);
}

function redactedHost(uri: string): string {
  return stripCredentials(uri).replace(/\?.*$/, '');
}

async function main(): Promise<number> {
  const config = loadConfigOrExit();
  console.log(`Setting up database "${config.dbName}" on ${redactedHost(config.mongodbUri)}`);

  let admin: MongoClient;
  try {
    admin = await connectAdmin(config, { serverSelectionTimeoutMS: 10_000 });
  } catch (err) {
    console.error(`Cannot connect with MONGODB_URI: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    const schema = await applySchema(admin.db(config.dbName));
    report('Schema', schema);
    const embedding = embeddingConfig();
    const vectorIndex = await ensureVectorIndex(admin.db(config.dbName), embedding.dimensions);
    console.log(`Vector index: ${vectorIndex} (${embedding.model}, ${embedding.dimensions} dims)`);

    let roles: ChangeSummary;
    let users: ChangeSummary;
    try {
      roles = await applyRoles(admin, config.dbName);
      report('Roles', roles);
      users = await ensureUsers(admin, config.dbName, config.users);
      report('Users', users);
    } catch (err) {
      if (!(err instanceof RoleManagementRefusedError)) throw err;
      console.error('');
      console.error(`Schema is applied, but roles and users were NOT set up.`);
      console.error(err.message);
      if (err.atlas) {
        console.error('');
        console.error('Next: print the role definitions with `npx tsx scripts/atlas-roles.ts`, create the five');
        console.error('roles and users in Atlas as described in docs/ATLAS_SETUP.md, set');
        console.error('MONGODB_ROLE_AUTH_SOURCE=admin in .env, then re-run `npm run setup`.');
      }
      return 2;
    }

    if (config.roleAuthSource !== config.dbName) {
      console.warn(
        `\nWarning: MONGODB_ROLE_AUTH_SOURCE is "${config.roleAuthSource}", but setup creates users in "${config.dbName}". ` +
          'Processes will fail to log in unless the users also exist there (on Atlas they live in "admin").',
      );
    }

    // Prove each user can log in with the credentials in config.
    const failed: string[] = [];
    for (const role of APP_ROLES) {
      try {
        const client = await connectAs(role, config, { serverSelectionTimeoutMS: 10_000 });
        await client.close();
      } catch (err) {
        failed.push(`${config.users[role].username} (${ROLE_NAMES[role]}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failed.length > 0) {
      console.error('\nLogin check failed for:');
      for (const line of failed) console.error(`  ${line}`);
      return 1;
    }
    console.log(`Login check: ${APP_ROLES.length} users OK`);

    const changed = hasChanges(schema) || hasChanges(roles) || hasChanges(users);
    console.log(changed ? '\nSetup complete.' : '\nSetup complete: no changes.');
    return 0;
  } finally {
    await admin.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
