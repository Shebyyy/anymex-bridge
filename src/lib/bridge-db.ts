import { join } from 'node:path'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'

const DB_PATH = join(process.cwd(), 'mini-services', 'data', 'bridge.db')

export async function queryBridgeData(section: string, type?: string) {
  if (!existsSync(DB_PATH)) return null

  const db = new Database(DB_PATH, { readonly: true })

  try {
    switch (section) {
      case 'health': {
        const r = db.prepare(`SELECT
          (SELECT COUNT(*) FROM users) as u,
          (SELECT COUNT(*) FROM user_repos) as r,
          (SELECT COUNT(*) FROM extensions) as e,
          (SELECT COUNT(*) FROM user_extensions) as i
        `).get() as any
        return { users: r?.u || 0, repos: r?.r || 0, extensions: r?.e || 0, installs: r?.i || 0, dbPresent: true }
      }
      case 'users': {
        const rows = db.prepare(`
          SELECT u.id, u.username,
            (SELECT COUNT(*) FROM user_repos WHERE user_id = u.id) as repo_count,
            (SELECT COUNT(*) FROM user_extensions WHERE user_id = u.id) as ext_count
          FROM users u ORDER BY u.username
        `).all() as any[]
        return rows
      }
      case 'repos': {
        const rows = db.prepare(`
          SELECT ur.user_id, ur.url, ur.type, ur.added, u.username
          FROM user_repos ur JOIN users u ON ur.user_id = u.id
          ORDER BY ur.added DESC
        `).all() as any[]
        return rows
      }
      case 'extensions': {
        let sql = 'SELECT e.id, e.name, e.type, e.version, e.icon_url, e.lang, e.is_nsfw, e.extra, (SELECT COUNT(*) FROM user_extensions WHERE ext_id = e.id) as install_count FROM extensions e'
        if (type) { sql += ' WHERE e.type = ?' }
        sql += ' ORDER BY e.name'
        const stmt = db.prepare(sql)
        const rows = (type ? stmt.all(type) : stmt.all()) as any[]
        return rows.map(row => {
          try { row.extra = row.extra ? JSON.parse(row.extra) : null } catch { row.extra = null }
          return row
        })
      }
      case 'installs': {
        const rows = db.prepare(`
          SELECT ue.user_id, ue.ext_id, u.username, e.name as ext_name, e.type
          FROM user_extensions ue
          JOIN users u ON ue.user_id = u.id
          JOIN extensions e ON ue.ext_id = e.id
          ORDER BY u.username, e.name
        `).all() as any[]
        return rows
      }
      default: return null
    }
  } finally {
    db.close()
  }
}
