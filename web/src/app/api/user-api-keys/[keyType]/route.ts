import {
  API_KEY_TYPES,
  type ApiKeyType,
  READABLE_NAME,
} from '@codebuff/common/api-keys/constants'
import { clearApiKey } from '@codebuff/common/api-keys/crypto'
import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'

import type { NextRequest } from 'next/server'

import { authOptions } from '@/app/api/auth/[...nextauth]/auth-options'
import { logger } from '@/util/logger'

interface RouteParams {
  params: {
    keyType: string
  }
}

/**
 * DELETE /api/user-api-keys/:keyType
 * Removes a specific API key for the authenticated user
 */
export async function DELETE(
  request: NextRequest,
  { params }: RouteParams,
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = session.user.id
  const { keyType } = params

  // Validate keyType
  if (!API_KEY_TYPES.includes(keyType as ApiKeyType)) {
    return NextResponse.json(
      {
        error: 'Invalid key type',
        message: `Key type must be one of: ${API_KEY_TYPES.join(', ')}`,
      },
      { status: 400 },
    )
  }

  try {
    await clearApiKey(userId, keyType as ApiKeyType)

    logger.info(
      { userId, keyType },
      'Successfully removed user API key',
    )

    return NextResponse.json({
      success: true,
      message: `${READABLE_NAME[keyType as ApiKeyType]} API key removed successfully`,
    })
  } catch (error) {
    logger.error({ error, userId, keyType }, 'Error removing user API key')
    return NextResponse.json(
      {
        error: 'Failed to remove API key',
        message:
          error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    )
  }
}

