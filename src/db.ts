/**
 * AnymeX Bridge — SQLite Database
 *
 * Tables:
 *   users          — identified by SSH public key fingerprint
 *   user_repos     — repos each user is subscribed to (with optional runtime tag)
 *   user_exts      — extensions each user has installed (just IDs + repo source)
 *
 * Note: the actual .apk/.cs3 binaries live on disk in data/exts/ (shared,
 * deduped). The DB only stores references, never blobs.
 *
 * Bun's sqlite uses :name (or $name / @name) placeholders for named binds.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { User, UserExtension, UserRepo } from './types.js';

const DATA_DIR = join(import.meta.dir, '..', 'data');
const DB_PATH = join(DATA_DIR, 'users.sqlite');

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    pubkey_fingerprint  TEXT UNIQUE NOT NULL,
    display_name        TEXT,
    created_at          INTEGER NOT NULL,
    last_seen           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_exts (
    user_id     TEXT NOT NULL,
    ext_id      TEXT NOT NULL,
    repo_url    TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, ext_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_user_exts_user ON user_exts(user_id);
`);

// --- Graceful migration for user_repos table ---
// We need PRIMARY KEY (user_id, repo_url, runtime) to allow the same repo
// under different runtimes. SQLite doesn't support ALTER TABLE to change PK,
// so we check the current PK and rebuild if needed.
try {
  const pkCols = db.prepare<{ name: string }, null>(
    `SELECT name FROM pragma_table_info('user_repos') WHERE pk > 0 ORDER BY pk`,
  ).all(null);
  const pkNames = pkCols.map(c => c.name);

  if (pkNames.length === 2 && pkNames[0] === 'user_id' && pkNames[1] === 'repo_url') {
    // Old schema: PK is (user_id, repo_url). Migrate to include runtime.
    console.log('[db] migrating user_repos PK from (user_id, repo_url) to (user_id, repo_url, runtime)');
    db.exec(`
      CREATE TABLE user_repos_new (
        user_id     TEXT NOT NULL,
        repo_url    TEXT NOT NULL,
        runtime     TEXT,
        added_at    INTEGER NOT NULL,
        PRIMARY KEY (user_id, repo_url, runtime),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO user_repos_new (user_id, repo_url, runtime, added_at)
        SELECT user_id, repo_url, runtime, added_at FROM user_repos;
      DROP TABLE user_repos;
      ALTER TABLE user_repos_new RENAME TO user_repos;
      CREATE INDEX IF NOT EXISTS idx_user_repos_user ON user_repos(user_id);
    `);
    console.log('[db] migration complete');
  } else if (pkNames.length === 0) {
    // Table doesn't exist yet — create with new schema.
    db.exec(`
      CREATE TABLE user_repos (
        user_id     TEXT NOT NULL,
        repo_url    TEXT NOT NULL,
        runtime     TEXT,
        added_at    INTEGER NOT NULL,
        PRIMARY KEY (user_id, repo_url, runtime),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_user_repos_user ON user_repos(user_id);
    `);
  }
  // If PK already includes runtime, we're good.
} catch (e: any) {
  // Table might not exist yet (first run) — create it.
  console.log('[db] user_repos check failed, creating fresh table:', e?.message);
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_repos (
      user_id     TEXT NOT NULL,
      repo_url    TEXT NOT NULL,
      runtime     TEXT,
      added_at    INTEGER NOT NULL,
      PRIMARY KEY (user_id, repo_url, runtime),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_repos_user ON user_repos(user_id);
  `);
}

// --- Prepared statements (named parameters, $-prefixed) ---
// NOTE: bun:sqlite returns rows with the DB column names (snake_case).
// We alias every SELECT to camelCase so the rows match the TS interfaces.

const stmtGetUserByFingerprint = db.prepare<User, { $fingerprint: string }>(
  `SELECT id, pubkey_fingerprint AS pubkeyFingerprint, display_name AS displayName,
          created_at AS createdAt, last_seen AS lastSeen
   FROM users WHERE pubkey_fingerprint = $fingerprint`,
);

const stmtCreateUser = db.prepare<
  User,
  { $id: string; $fingerprint: string; $display_name: string | null; $created_at: number; $last_seen: number }
>(`INSERT INTO users (id, pubkey_fingerprint, display_name, created_at, last_seen)
   VALUES ($id, $fingerprint, $display_name, $created_at, $last_seen)
   RETURNING id, pubkey_fingerprint AS pubkeyFingerprint, display_name AS displayName,
             created_at AS createdAt, last_seen AS lastSeen`);

const stmtTouchUser = db.prepare<null, { $last_seen: number; $id: string }>(
  `UPDATE users SET last_seen = $last_seen WHERE id = $id`,
);

const stmtAddRepo = db.prepare<
  null,
  { $user_id: string; $repo_url: string; $runtime: string | null; $added_at: number }
>(`INSERT OR REPLACE INTO user_repos (user_id, repo_url, runtime, added_at) VALUES ($user_id, $repo_url, $runtime, $added_at)`);

const stmtRemoveRepo = db.prepare<null, { $user_id: string; $repo_url: string }>(
  `DELETE FROM user_repos WHERE user_id = $user_id AND repo_url = $repo_url`,
);

const stmtRemoveRepoByRuntime = db.prepare<null, { $user_id: string; $repo_url: string; $runtime: string }>(
  `DELETE FROM user_repos WHERE user_id = $user_id AND repo_url = $repo_url AND runtime = $runtime`,
);

const stmtRemoveExtsForRepo = db.prepare<null, { $user_id: string; $repo_url: string }>(
  `DELETE FROM user_exts WHERE user_id = $user_id AND repo_url = $repo_url`,
);

const stmtListRepos = db.prepare<UserRepo, { $user_id: string }>(
  `SELECT user_id AS userId, repo_url AS repoUrl, runtime, added_at AS addedAt
   FROM user_repos WHERE user_id = $user_id ORDER BY added_at ASC`,
);

const stmtListReposByRuntime = db.prepare<UserRepo, { $user_id: string; $runtime: string }>(
  `SELECT user_id AS userId, repo_url AS repoUrl, runtime, added_at AS addedAt
   FROM user_repos WHERE user_id = $user_id AND runtime = $runtime ORDER BY added_at ASC`,
);

const stmtHasOtherRuntimeRepo = db.prepare<{ count: number }, { $user_id: string; $repo_url: string; $runtime: string | null }>(
  `SELECT COUNT(*) as count FROM user_repos WHERE user_id = $user_id AND repo_url = $repo_url AND runtime != $runtime`,
);

const stmtInstallExt = db.prepare<
  null,
  { $user_id: string; $ext_id: string; $repo_url: string; $installed_at: number }
>(`INSERT OR REPLACE INTO user_exts (user_id, ext_id, repo_url, installed_at) VALUES ($user_id, $ext_id, $repo_url, $installed_at)`);

const stmtUninstallExt = db.prepare<null, { $user_id: string; $ext_id: string }>(
  `DELETE FROM user_exts WHERE user_id = $user_id AND ext_id = $ext_id`,
);

const stmtListUserExts = db.prepare<UserExtension, { $user_id: string }>(
  `SELECT user_id AS userId, ext_id AS extId, repo_url AS repoUrl, installed_at AS installedAt
   FROM user_exts WHERE user_id = $user_id ORDER BY installed_at ASC`,
);

const stmtGetExtUsage = db.prepare<{ count: number }, { $ext_id: string }>(
  `SELECT COUNT(*) as count FROM user_exts WHERE ext_id = $ext_id`,
);

const stmtIsExtInstalled = db.prepare<{ ok: number }, { $user_id: string; $ext_id: string }>(
  `SELECT 1 as ok FROM user_exts WHERE user_id = $user_id AND ext_id = $ext_id LIMIT 1`,
);

// --- Helper: check if a repo exists under a different runtime ---

function hasOtherRuntimeRepo(userId: string, repoUrl: string, runtime: string | null): boolean {
  const row = stmtHasOtherRuntimeRepo.get({ $user_id: userId, $repo_url: repoUrl, $runtime: runtime });
  return (row?.count ?? 0) > 0;
}

// --- Valid runtime values ---
const VALID_RUNTIMES = ['aniyomi', 'cloudstream', 'kotatsu'] as const;
type ValidRuntime = (typeof VALID_RUNTIMES)[number];

function isValidRuntime(v: unknown): v is ValidRuntime {
  return typeof v === 'string' && VALID_RUNTIMES.includes(v as ValidRuntime);
}

// --- Public API ---

export function getOrCreateUser(fingerprint: string, displayName?: string): User {
  const existing = stmtGetUserByFingerprint.get({ $fingerprint: fingerprint });
  if (existing) {
    stmtTouchUser.run({ $last_seen: Date.now(), $id: existing.id });
    return existing;
  }
  const id = `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  const created = stmtCreateUser.get({
    $id: id,
    $fingerprint: fingerprint,
    $display_name: displayName ?? null,
    $created_at: now,
    $last_seen: now,
  })!;
  return created;
}

export function addRepo(userId: string, repoUrl: string, runtime?: string): void {
  const safeRuntime = isValidRuntime(runtime) ? runtime : null;
  stmtAddRepo.run({ $user_id: userId, $repo_url: repoUrl, $runtime: safeRuntime, $added_at: Date.now() });
}

export function removeRepo(userId: string, repoUrl: string, runtime?: string): void {
  if (runtime && isValidRuntime(runtime)) {
    stmtRemoveRepoByRuntime.run({ $user_id: userId, $repo_url: repoUrl, $runtime: runtime });
    // Only remove extensions for this repo if no other runtime still has it
    if (!hasOtherRuntimeRepo(userId, repoUrl, runtime)) {
      stmtRemoveExtsForRepo.run({ $user_id: userId, $repo_url: repoUrl });
    }
  } else {
    // No runtime specified — remove ALL rows for this repo (all runtimes)
    stmtRemoveRepo.run({ $user_id: userId, $repo_url: repoUrl });
    stmtRemoveExtsForRepo.run({ $user_id: userId, $repo_url: repoUrl });
  }
}

export function listRepos(userId: string, runtime?: string): UserRepo[] {
  if (runtime && isValidRuntime(runtime)) {
    return stmtListReposByRuntime.all({ $user_id: userId, $runtime: runtime });
  }
  return stmtListRepos.all({ $user_id: userId });
}

export function installExt(userId: string, extId: string, repoUrl: string): void {
  stmtInstallExt.run({
    $user_id: userId,
    $ext_id: extId,
    $repo_url: repoUrl,
    $installed_at: Date.now(),
  });
}

export function uninstallExt(userId: string, extId: string): void {
  stmtUninstallExt.run({ $user_id: userId, $ext_id: extId });
}

export function listUserExts(userId: string): UserExtension[] {
  return stmtListUserExts.all({ $user_id: userId });
}

export function isExtInstalled(userId: string, extId: string): boolean {
  return stmtIsExtInstalled.get({ $user_id: userId, $ext_id: extId }) != null;
}

export function getExtUserCount(extId: string): number {
  return stmtGetExtUsage.get({ $ext_id: extId })?.count ?? 0;
}

export { db };
