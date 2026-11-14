/**
 * Environment configuration.
 *
 * Required:
 *   MONGODB_URI              Connection string with ADMIN credentials (used by
 *                            setup/seed/reset and as the host list for role users).
 * Optional (dev defaults shown in .env.example):
 *   MONGODB_DB               Application database name (default "escrowops").
 *   MONGODB_ROLE_AUTH_SOURCE Database role users authenticate against
 *                            (default: same as MONGODB_DB; "admin" on Atlas).
 *   <ROLE>_DB_USER / <ROLE>_DB_PASSWORD for ROLE in AGENT, APPROVER, EXECUTOR,
 *                            DASHBOARD, ADMIN.
 *
 * Two entry points:
 * - `loadConfig(env)` is pure: it reads only the given env object and throws
 *   `MissingEnvError` (with `.variable`) when a required value is missing.
 *   Use it in tests and libraries.
 * - `loadConfigOrExit()` loads `.env`, then calls loadConfig; on a missing
 *   variable it prints a message naming it and exits with code 1 (O5).
 *   Use it at the top of scripts and processes.
 */
import { config as loadDotenv } from 'dotenv';
import { APP_ROLES, type AppRole, type UserCredentials } from './roles.js';

export interface Config {
  /** Admin connection string. */
  mongodbUri: string;
  /** Application database. */
  dbName: string;
  /** authSource for the per-role users. */
  roleAuthSource: string;
  /** Credentials for each process identity. */
  users: Record<AppRole, UserCredentials>;
}

export type Env = Record<string, string | undefined>;

export const DEFAULT_DB_NAME = 'escrowops';

/** Dev-only defaults. Never used for anything but local and test databases. */
export const DEFAULT_USERS: Readonly<Record<AppRole, UserCredentials>> = Object.freeze({
  agent: { username: 'escrow_agent', password: 'agent-dev-password' },
  approver: { username: 'escrow_approver', password: 'approver-dev-password' },
  executor: { username: 'escrow_executor', password: 'executor-dev-password' },
  dashboard: { username: 'escrow_dashboard', password: 'dashboard-dev-password' },
  admin: { username: 'escrow_admin', password: 'admin-dev-password' },
});

export class MissingEnvError extends Error {
  readonly variable: string;
  constructor(variable: string, hint?: string) {
    super(`Missing required environment variable ${variable}${hint ? `. ${hint}` : ''}`);
    this.name = 'MissingEnvError';
    this.variable = variable;
  }
}

/** Env var names for a role's credentials, e.g. AGENT_DB_USER / AGENT_DB_PASSWORD. */
export function roleEnvVars(role: AppRole): { user: string; password: string } {
  const prefix = role.toUpperCase();
  return { user: `${prefix}_DB_USER`, password: `${prefix}_DB_PASSWORD` };
}

function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export function requireEnv(env: Env, name: string, hint?: string): string {
  const value = read(env, name);
  if (value === undefined) throw new MissingEnvError(name, hint);
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  const mongodbUri = requireEnv(
    env,
    'MONGODB_URI',
    'Set it in .env (see .env.example) to a connection string with admin credentials',
  );
  const dbName = read(env, 'MONGODB_DB') ?? DEFAULT_DB_NAME;
  const roleAuthSource = read(env, 'MONGODB_ROLE_AUTH_SOURCE') ?? dbName;

  const users = {} as Record<AppRole, UserCredentials>;
  for (const role of APP_ROLES) {
    const vars = roleEnvVars(role);
    users[role] = {
      username: read(env, vars.user) ?? DEFAULT_USERS[role].username,
      password: read(env, vars.password) ?? DEFAULT_USERS[role].password,
    };
  }
  return { mongodbUri, dbName, roleAuthSource, users };
}

let dotenvLoaded = false;

/** Load `.env` (once) without overriding variables already set in the process. */
export function loadEnvFile(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  loadDotenv({ quiet: true });
}

export function loadConfigOrExit(): Config {
  loadEnvFile();
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof MissingEnvError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
