import {
  API_KEY_TYPES,
  type ApiKeyType,
  READABLE_NAME,
} from '@codebuff/common/api-keys/constants'
import {
  encryptAndStoreApiKey,
  validateApiKey,
} from '@codebuff/common/api-keys/crypto'
import db from '@codebuff/common/db'
import * as schema from '@codebuff/common/db/schema'
import { eq } from 'drizzle-orm'
import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { z } from 'zod/v4'

import type { NextRequest } from 'next/server'

import { authOptions } from '@/app/api/auth/[...nextauth]/auth-options'
import { logger } from '@/util/logger'

/**
 * GET /api/user-api-keys
 * Returns a list of configured API key types for the authenticated user
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = session.user.id

  try {
    // Fetch all encrypted API keys for this user
    const userKeys = await db.query.encryptedApiKeys.findMany({
      where: eq(schema.encryptedApiKeys.user_id, userId),
      columns: {
        type: true,
      },
    })

    // Create a map of configured keys
    const configuredKeys = new Set(userKeys.map((k) => k.type))

    // Build response with all key types
    const keys = API_KEY_TYPES.map((keyType) => ({
      type: keyType,
      name: READABLE_NAME[keyType],
      configured: configuredKeys.has(keyType),
    }))

    return NextResponse.json({ keys })
  } catch (error) {
    logger.error(
      { error, userId },
      'Error fetching user API keys configuration',
    )
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/user-api-keys
 * Stores or updates an API key for the authenticated user
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = session.user.id

  try {
    const body = await request.json()

    // Validate request body
    const schema = z.object({
      keyType: z.enum(API_KEY_TYPES),
      apiKey: z.string().min(1, 'API key cannot be empty'),
    })

    const parseResult = schema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          details: parseResult.error.errors,
        },
        { status: 400 },
      )
    }

    const { keyType, apiKey } = parseResult.data

    // Validate API key format
    if (!validateApiKey(keyType, apiKey)) {
      return NextResponse.json(
        {
          error: `Invalid ${READABLE_NAME[keyType]} API key format`,
          message: `Please check that your API key is correct and matches the expected format for ${READABLE_NAME[keyType]}.`,
        },
        { status: 400 },
      )
    }

    // Encrypt and store the API key
    await encryptAndStoreApiKey(userId, keyType, apiKey)

    logger.info(
      { userId, keyType },
      'Successfully stored user API key',
    )

    return NextResponse.json({
      success: true,
      message: `${READABLE_NAME[keyType]} API key stored successfully`,
    })
  } catch (error) {
    logger.error({ error, userId }, 'Error storing user API key')
    return NextResponse.json(
      {
        error: 'Failed to store API key',
        message:
          error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    )
  }
}

