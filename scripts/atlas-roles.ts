/**
 * npx tsx scripts/atlas-roles.ts [--db <name>] [--format json|cli]
 *
 * Prints the five EscrowOps roles in the shape Atlas custom database roles
 * expect, generated from ROLE_DEFINITIONS (packages/shared/src/roles.ts), the
 * same source `npm run setup` uses with createRole locally. Nothing is sent
 * anywhere: apply the output through the Atlas UI, CLI or Admin API as
 * described in docs/ATLAS_SETUP.md.
 *
 *   --format json (default)  One Admin API request body per role, as a JSON
 *                            array (POST .../groups/{groupId}/customDBRoles/roles).
 *   --format cli             One `atlas customDbRoles create` command per role.
 *   --db                     Application database (default: MONGODB_DB or "escrowops").
 *
 * UNVERIFIED against a real Atlas project (no credentials were available).
 * The action-name mapping is a mechanical camelCase -> UPPER_SNAKE_CASE
 * conversion (find -> FIND, changeStream -> CHANGE_STREAM, collMod ->
 * COLL_MOD); confirm each name in the Atlas Admin API reference for custom
 * database roles before relying on it. See docs/ATLAS_SETUP.md.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DB_NAME, ROLE_DEFINITIONS, loadEnvFile, type RoleDefinition } from '@escrowops/shared';

export interface AtlasResource {
  db: string;
  /** "" means every collection in `db`. */
  collection: string;
}

export interface AtlasAction {
  action: string;
  resources: AtlasResource[];
}

/** Request body for the Atlas Admin API "create one custom role" endpoint. */
export interface AtlasCustomRole {
  roleName: string;
  actions: AtlasAction[];
  inheritedRoles: [];
}

/** Server action name -> Atlas action name: find -> FIND, changeStream -> CHANGE_STREAM. */
export function toAtlasAction(action: string): string {
  return action.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** One role as an Atlas custom role: actions grouped, each listing the resources it applies to. */
export function toAtlasCustomRole(def: RoleDefinition, dbName: string): AtlasCustomRole {
  const byAction = new Map<string, AtlasResource[]>();
  for (const privilege of def.privileges) {
    for (const action of privilege.actions) {
      const name = toAtlasAction(action);
      const list = byAction.get(name) ?? [];
      list.push({ db: dbName, collection: privilege.collection });
      byAction.set(name, list);
    }
  }
  return {
    roleName: def.role,
    actions: [...byAction.entries()].map(([action, resources]) => ({ action, resources })),
    inheritedRoles: [],
  };
}

export function atlasCustomRoles(dbName: string): AtlasCustomRole[] {
  return ROLE_DEFINITIONS.map((def) => toAtlasCustomRole(def, dbName));
}

/** `atlas customDbRoles create` commands. Privilege syntax ACTION@DB[.COLLECTION]: confirm with `atlas customDbRoles create --help`. */
export function atlasCliCommands(dbName: string): string[] {
  return atlasCustomRoles(dbName).map((role) => {
    const privileges = role.actions.flatMap((a) =>
      a.resources.map((r) => `${a.action}@${r.db}${r.collection === '' ? '' : `.${r.collection}`}`),
    );
    return `atlas customDbRoles create ${role.roleName} --privilege ${privileges.join(',')} --projectId "$ATLAS_PROJECT_ID"`;
  });
}

function arg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function main(): number {
  loadEnvFile();
  const dbName = arg('db') ?? (process.env['MONGODB_DB']?.trim() || DEFAULT_DB_NAME);
  const format = arg('format') ?? 'json';
  if (format === 'json') {
    console.log(JSON.stringify(atlasCustomRoles(dbName), null, 2));
    return 0;
  }
  if (format === 'cli') {
    console.log(`# Generated from ROLE_DEFINITIONS for database "${dbName}". UNVERIFIED syntax: see docs/ATLAS_SETUP.md.`);
    for (const line of atlasCliCommands(dbName)) console.log(line);
    return 0;
  }
  console.error(`Unknown --format "${format}" (expected json or cli)`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}
