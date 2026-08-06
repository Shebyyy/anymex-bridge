import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const DB_PATH = join(process.cwd(), 'mini-services', 'data', 'bridge.db')

export async function queryBridgeData(section: string, type?: string) {
  if (!existsSync(DB_PATH)) return null

  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const fileBuffer = readFileSync(DB_PATH)
  const db = new SQL.Database(fileBuffer)

  try {
    switch (section) {
      case 'health': {
        const r = db.exec('SELECT (SELECT COUNT(*) FROM users) as u, (SELECT COUNT(*) FROM user_repos) as r, (SELECT COUNT(*) FROM extensions) as e, (SELECT COUNT(*) FROM user_extensions) as i')
        const v = r[0]?.values[0]
        return { users: v?.[0]||0, repos: v?.[1]||0, extensions: v?.[2]||0, installs: v?.[3]||0, dbPresent: true }
      }
      case 'users': {
        const r = db.exec(`SELECT u.id, u.username, (SELECT COUNT(*) FROM user_repos WHERE user_id = u.id) as repo_count, (SELECT COUNT(*) FROM user_extensions WHERE user_id = u.id) as ext_count FROM users u ORDER BY u.username`)
        return toObj(r)
      }
      case 'repos': {
        const r = db.exec(`SELECT ur.user_id, ur.url, ur.type, ur.added, u.username as added_by_name FROM user_repos ur JOIN users u ON ur.user_id = u.id ORDER BY ur.added DESC`)
        return toObj(r)
      }
      case 'extensions': {
        let sql = 'SELECT e.id, e.name, e.type, e.version, e.icon_url, e.lang, e.is_nsfw, e.extra, (SELECT COUNT(*) FROM user_extensions WHERE ext_id = e.id) as install_count FROM extensions e'
        const params: string[] = []
        if (type) { sql += ' WHERE e.type = ?'; params.push(type) }
        sql += ' ORDER BY e.name'
        const r = db.exec(sql, params)
        return toObj(r).map((row: any) => { try { row.extra = row.extra ? JSON.parse(row.extra) : null } catch { row.extra = null }; return row })
      }
      case 'installs': {
        const r = db.exec(`SELECT ue.user_id, ue.ext_id, u.username, e.name as ext_name, e.type FROM user_extensions ue JOIN users u ON ue.user_id = u.id JOIN extensions e ON ue.ext_id = e.id ORDER BY u.username, e.name`)
        return toObj(r)
      }
      default: return null
    }
  } finally { db.close() }
}

function toObj(result: any[]) {
  if (!result[0]) return []
  const cols = result[0].columns
  return result[0].values.map((row: any[]) => { const o: Record<string,any> = {}; cols.forEach((c: string, i: number) => o[c] = row[i]); return o })
}
