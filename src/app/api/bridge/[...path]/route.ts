import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, params, 'GET')
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, params, 'POST')
}

async function proxyRequest(
  request: NextRequest,
  params: Promise<{ path: string[] }>,
  method: 'GET' | 'POST'
) {
  try {
    const { path } = await params
    const resolvedPath = path.join('/')

    // Get active server config from DB
    const config = await db.bridgeServerConfig.findFirst({
      where: { isActive: true }
    })

    if (!config) {
      return NextResponse.json(
        { success: false, error: 'No active bridge server configured' },
        { status: 400 }
      )
    }

    const baseUrl = config.serverUrl.replace(/\/+$/, '')
    const targetUrl = `${baseUrl}/${resolvedPath}`

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    }

    if (method === 'POST') {
      const body = await request.text()
      fetchOptions.body = body
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const response = await fetch(targetUrl, {
        ...fetchOptions,
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const data = await response.json()
      return NextResponse.json(data, { status: response.status })
    } catch (fetchError) {
      clearTimeout(timeout)
      const errorMessage =
        fetchError instanceof Error && fetchError.name === 'AbortError'
          ? 'Request to bridge server timed out'
          : fetchError instanceof Error
            ? `Failed to reach bridge server: ${fetchError.message}`
            : 'Failed to reach bridge server'

      return NextResponse.json(
        { success: false, error: errorMessage },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Bridge proxy error:', error)
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}
