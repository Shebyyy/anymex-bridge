/**
 * AnymeX Bridge — SQLite Database
 *
 * Tables:
 *   users          — identified by SSH public key fingerprint
 *   user_repos     — repos each user is subscribed to
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

  CREATE TABLE IF NOT EXISTS user_repos (
    user_id     TEXT NOT NULL,
    repo_url    TEXT NOT NULL,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (user_id, repo_url),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_exts (
    user_id     TEXT NOT NULL,
    ext_id      TEXT NOT NULL,
    repo_url    TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, ext_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_user_repos_user ON user_repos(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_exts_user ON user_exts(user_id);
`);

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
  { $user_id: string; $repo_url: string; $added_at: number }
>(`INSERT OR IGNORE INTO user_repos (user_id, repo_url, added_at) VALUES ($user_id, $repo_url, $added_at)`);

const stmtRemoveRepo = db.prepare<null, { $user_id: string; $repo_url: string }>(
  `DELETE FROM user_repos WHERE user_id = $user_id AND repo_url = $repo_url`,
);

const stmtRemoveExtsForRepo = db.prepare<null, { $user_id: string; $repo_url: string }>(
  `DELETE FROM user_exts WHERE user_id = $user_id AND repo_url = $repo_url`,
);

const stmtListRepos = db.prepare<UserRepo, { $user_id: string }>(
  `SELECT user_id AS userId, repo_url AS repoUrl, added_at AS addedAt
   FROM user_repos WHERE user_id = $user_id ORDER BY added_at ASC`,
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

export function addRepo(userId: string, repoUrl: string): void {
  stmtAddRepo.run({ $user_id: userId, $repo_url: repoUrl, $added_at: Date.now() });
}

export function removeRepo(userId: string, repoUrl: string): void {
  stmtRemoveRepo.run({ $user_id: userId, $repo_url: repoUrl });
  stmtRemoveExtsForRepo.run({ $user_id: userId, $repo_url: repoUrl });
}

export function listRepos(userId: string): UserRepo[] {
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
