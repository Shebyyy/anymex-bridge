import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// GET /api/bridge-config — get current config
export async function GET() {
  try {
    const configs = await db.bridgeServerConfig.findMany({
      orderBy: { updatedAt: 'desc' }
    })
    const activeConfig = configs.find(c => c.isActive)

    return NextResponse.json({
      success: true,
      data: {
        configs,
        activeConfig: activeConfig || null,
        serverUrl: activeConfig?.serverUrl || ''
      }
    })
  } catch (error) {
    console.error('Failed to get bridge config:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to get config' },
      { status: 500 }
    )
  }
}

// POST /api/bridge-config — save/connect/disconnect
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { serverUrl, action } = body

    if (!serverUrl || typeof serverUrl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Server URL is required' },
        { status: 400 }
      )
    }

    const normalizedUrl = serverUrl.replace(/\/+$/, '')

    if (action === 'connect') {
      // Deactivate all other configs
      await db.bridgeServerConfig.updateMany({
        where: { isActive: true },
        data: { isActive: false }
      })

      // Upsert and activate this config
      const config = await db.bridgeServerConfig.upsert({
        where: { serverUrl: normalizedUrl },
        update: { isActive: true },
        create: { serverUrl: normalizedUrl, isActive: true }
      })

      return NextResponse.json({ success: true, data: config })
    }

    if (action === 'disconnect') {
      await db.bridgeServerConfig.updateMany({
        where: { isActive: true },
        data: { isActive: false }
      })

      return NextResponse.json({ success: true, data: null })
    }

    if (action === 'save') {
      const config = await db.bridgeServerConfig.upsert({
        where: { serverUrl: normalizedUrl },
        update: { serverUrl: normalizedUrl },
        create: { serverUrl: normalizedUrl }
      })

      return NextResponse.json({ success: true, data: config })
    }

    return NextResponse.json(
      { success: false, error: 'Invalid action. Use connect, disconnect, or save.' },
      { status: 400 }
    )
  } catch (error) {
    console.error('Failed to save bridge config:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to save config' },
      { status: 500 }
    )
  }
}
