import { NextRequest, NextResponse } from 'next/server'

const BRIDGE_HTTP = process.env.BRIDGE_HTTP_URL || 'http://localhost:8081'

/**
 * Proxy all requests to the bridge service's HTTP endpoint.
 * Used for: /health, /register
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const path = searchParams.get('path') || '/health'

  try {
    const res = await fetch(`${BRIDGE_HTTP}${path}`)
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'bridge service not reachable' }, { status: 503 })
  }
}

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const path = searchParams.get('path') || '/register'

  try {
    const body = await req.json()
    const res = await fetch(`${BRIDGE_HTTP}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'bridge service not reachable' }, { status: 503 })
  }
}
