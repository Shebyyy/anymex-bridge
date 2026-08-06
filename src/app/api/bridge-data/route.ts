import { NextRequest, NextResponse } from 'next/server'
import { queryBridgeData } from '@/lib/bridge-db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const section = searchParams.get('section') || 'health'
  const type = searchParams.get('type') || undefined

  try {
    const data = await queryBridgeData(section, type)
    if (data === null) {
      return NextResponse.json({ error: 'database not found — start the bridge service first' }, { status: 503 })
    }
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
