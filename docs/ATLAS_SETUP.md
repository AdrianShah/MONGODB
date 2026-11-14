# Atlas Setup: Roles and Users

How to give an Atlas cluster the same five roles and five users that `npm run setup` creates locally with `createRole` / `createUser`.

> **Status: UNVERIFIED.** Nothing in this document has been run against a real Atlas project; no credentials were available when it was written. The role *privileges* are exact (they come from the same `ROLE_DEFINITIONS` the local tests prove). The Atlas *action names*, CLI flag syntax and API paths below are written from general knowledge of Atlas and must be confirmed in the Atlas documentation before use. Every such point is marked **Confirm**.

## Why Atlas is different

On a local server (in-memory test server, Docker), `npm run setup` creates the roles and users inside the application database with database commands. Atlas refuses those commands from a database connection: custom roles and database users belong to the Atlas project and are managed through the Atlas control plane (UI, `atlas` CLI, or Admin API). They live in the `admin` database.

When `npm run setup` hits that refusal it still applies the schema (collections, validators, indexes), then stops with exit code 2 and a message pointing here instead of a stack trace.

## 1. Generate the role definitions

The definitions are generated from `ROLE_DEFINITIONS` in `packages/shared/src/roles.ts`, the single source of truth. Do not hand-edit roles in Atlas; change `roles.ts` and regenerate.

```sh
npx tsx scripts/atlas-roles.ts                 # JSON: one Admin API request body per role
npx tsx scripts/atlas-roles.ts --format cli    # one `atlas customDbRoles create` command per role
npx tsx scripts/atlas-roles.ts --db mydb       # another application database (default: MONGODB_DB or escrowops)
```

What the script does:

- Converts each server action name to Atlas style by a mechanical camelCase to UPPER_SNAKE_CASE rule: `find` to `FIND`, `insert` to `INSERT`, `update` to `UPDATE`, `changeStream` to `CHANGE_STREAM`, `collMod` to `COLL_MOD`, `createIndex` to `CREATE_INDEX`, `dropIndex` to `DROP_INDEX`, `listIndexes` to `LIST_INDEXES`, `listCollections` to `LIST_COLLECTIONS`, `createCollection` to `CREATE_COLLECTION`.
  **Confirm** each name against the list of actions Atlas accepts for custom database roles (Admin API reference, "Custom Database Roles", the `action` enum). If one differs, fix `toAtlasAction` in `scripts/atlas-roles.ts`; do not edit the output by hand.
- Groups privileges by action, each with its list of `{ db, collection }` resources, and sets `inheritedRoles: []`.
- Uses `collection: ""` for database-wide privileges (`dashboard_role` and parts of `admin_role`). **Confirm** that Atlas accepts an empty collection name as "every collection in the database".

The five roles, as in PRD section 7:

| Role | Privileges |
|---|---|
| `agent_role` | `FIND` on tickets, orders, customers, policies. `INSERT` on agent_traces, intents, review_queue. |
| `approver_role` | `FIND` + `CHANGE_STREAM` + `UPDATE` on review_queue. `FIND` + `INSERT` on approvals. `INSERT` on approved. |
| `executor_role` | `FIND` + `CHANGE_STREAM` on intents, approved. `FIND` + `INSERT` + `UPDATE` on ledger, budgets, executor_state. `FIND` on orders. |
| `dashboard_role` | `FIND` + `CHANGE_STREAM` on the whole application database. |
| `admin_role` | `LIST_COLLECTIONS`, `CREATE_COLLECTION`, `COLL_MOD`, `LIST_INDEXES`, `CREATE_INDEX`, `DROP_INDEX` on the database. `FIND` + `INSERT` + `UPDATE` on policies. |

## 2. Check the cluster tier first

Free and shared tiers (M0, Flex) restrict which actions custom roles may use. Before creating anything, check that the tier allows `CHANGE_STREAM`, `COLL_MOD` and collection-level resources. **Confirm** in the Atlas documentation page on unsupported commands / custom role limits for your tier.

If the tier does not allow them, use the PRD fallback: the local `mongodb/mongodb-atlas-local` image (`docker-compose.yml`), where `npm run setup` creates everything itself.

## 3. Create the roles

Pick one of the three routes.

### Atlas UI

Project, then **Database Access**, then **Custom Roles**, then **Add New Custom Role**. For each role, enter the role name exactly (`agent_role`, ...), and for each action in the generated JSON pick the action and enter the database and collection (leave collection empty for database-wide entries). Do not add inherited roles.

### Atlas CLI

```sh
export ATLAS_PROJECT_ID=<your project id>
atlas auth login
npx tsx scripts/atlas-roles.ts --format cli > /tmp/escrowops-roles.sh
# read it, then:
sh /tmp/escrowops-roles.sh
atlas customDbRoles list --projectId "$ATLAS_PROJECT_ID"
```

The generated commands use `--privilege ACTION@DB.COLLECTION` (or `ACTION@DB` for database-wide), comma-separated. **Confirm** with `atlas customDbRoles create --help` that this is the flag syntax of your CLI version.

### Admin API

One `POST` per element of the JSON array:

```sh
npx tsx scripts/atlas-roles.ts > roles.json
# for each element:
curl --digest -u "$ATLAS_PUBLIC_KEY:$ATLAS_PRIVATE_KEY" \
  -H 'Accept: application/vnd.atlas.2023-01-01+json' -H 'Content-Type: application/json' \
  -X POST "https://cloud.mongodb.com/api/atlas/v2/groups/$ATLAS_PROJECT_ID/customDBRoles/roles" \
  --data @one-role.json
```

**Confirm** the endpoint path, the versioned `Accept` header, and the request body field names (`roleName`, `actions[].action`, `actions[].resources[].db` / `.collection`, `inheritedRoles`) in the Admin API reference. To update a role later, the API has a `PATCH` on `.../customDBRoles/roles/{roleName}`; **Confirm**.

## 4. Create the five database users

One user per process, each granted only its own custom role, with the usernames and passwords from `.env` (`AGENT_DB_USER` / `AGENT_DB_PASSWORD`, and so on for APPROVER, EXECUTOR, DASHBOARD, ADMIN). Use real passwords, not the dev defaults.

| Env prefix | Default username | Role |
|---|---|---|
| `AGENT_` | `escrow_agent` | `agent_role` |
| `APPROVER_` | `escrow_approver` | `approver_role` |
| `EXECUTOR_` | `escrow_executor` | `executor_role` |
| `DASHBOARD_` | `escrow_dashboard` | `dashboard_role` |
| `ADMIN_` | `escrow_admin` | `admin_role` |

- **UI:** Database Access, then Database Users, then Add New Database User; password authentication; under Database User Privileges pick the custom role only. Do not also grant a built-in role such as `readWrite`, which would defeat the least-privilege design.
- **CLI:** `atlas dbusers create --username escrow_agent --password '<pw>' --role agent_role --projectId "$ATLAS_PROJECT_ID"`. **Confirm** how your CLI version names a custom role in `--role` (it may expect `agent_role@admin`).
- **Admin API:** `POST .../groups/{groupId}/databaseUsers` with `databaseName: "admin"` and `roles: [{ roleName: "agent_role", databaseName: "admin" }]`. **Confirm**.

The MONGODB_URI user (used by setup, seed and reset) stays a separate, privileged Atlas user.

## 5. Point the app at the `admin` auth source

Atlas database users authenticate against `admin`, so set in `.env`:

```sh
MONGODB_ROLE_AUTH_SOURCE=admin
```

Then run `npm run setup` again. It applies the schema and reports the role refusal again (exit code 2). That is expected on Atlas: from a database connection it cannot create or compare roles there.

## 6. Verify

Run the red team against the cluster with the agent's credentials:

```sh
npm run redteam
```

Expected: five `DENIED` lines (121 for the oversized insert, 13 for the rest) and `Payouts caused: 0`, exit code 0. The script only uses the agent and dashboard users, never the admin URI, and never inserts a payable intent.

To run the full role suite (R1 to R26) against Atlas, the test harness would need to use pre-created users instead of creating its own; that is not built yet (see open items).

## What is not verified

| Item | Where to confirm |
|---|---|
| Atlas action names for every action used (especially `CHANGE_STREAM`, `COLL_MOD`, `LIST_COLLECTIONS`, `CREATE_COLLECTION`) | Atlas Admin API reference, Custom Database Roles, `action` enum |
| `collection: ""` means database-wide in Atlas custom roles | Same reference, resource object |
| `atlas customDbRoles create --privilege` syntax | `atlas customDbRoles create --help` |
| How `atlas dbusers create --role` names a custom role | `atlas dbusers create --help` |
| Admin API paths, version header and body fields | Atlas Admin API v2 reference |
| Tier limits on custom role actions (M0, Flex) | Atlas docs on free and Flex cluster limitations |
| The exact error Atlas returns for `createRole` / `rolesInfo` from a database connection. `applyRoles` treats code 8000, `AtlasError`, "not allowed" / `CMD_NOT_ALLOWED`, and code 13 as a refusal; the Atlas-specific hint is shown only for the first three. | Run `npm run setup` once against the cluster |
| Change Streams with these custom roles on the chosen tier | `npm run redteam` and the executor, once running |

## Open items

- The role tests (`tests/roles`) create their own users and roles per test database, which Atlas does not allow. Running them on Atlas needs a mode that uses the five pre-created users and a single shared database.
- `npm run setup` cannot detect drift between `ROLE_DEFINITIONS` and the roles in Atlas. After changing `roles.ts`, regenerate and re-apply the roles by hand.

## Kill switch on Atlas

`npm run freeze` and the dashboard's **Freeze agent** button run `updateRole agent_role` from a database connection. Atlas refuses that, the same way it refuses `createRole`, so on Atlas the freeze stops with a "role management refused" message and changes nothing: no privilege change, no voided intents. To freeze the agent on Atlas, edit the `agent_role` custom role in the Atlas control plane and remove `INSERT` on `intents` and `review_queue` (**Confirm**: the Admin API's custom database role update endpoint). Changes made in the control plane can take a short while to reach the cluster. The local and test paths are what `tests/roles/kill-switch.test.ts` proves.
