import { google } from '@ai-sdk/google'
import { openai } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { env } from '@codebuff/internal'
import {
  finetunedVertexModels,
  geminiModels,
  openaiModels,
} from '@codebuff/common/old-constants'
import { buildArray } from '@codebuff/common/util/array'
import { convertCbToModelMessages } from '@codebuff/common/util/messages'
import { errorToObject } from '@codebuff/common/util/object'
import { withTimeout } from '@codebuff/common/util/promise'
import { StopSequenceHandler } from '@codebuff/common/util/stop-sequence'
import { generateCompactId } from '@codebuff/common/util/string'
import { APICallError, generateObject, generateText, streamText } from 'ai'

import { checkLiveUserInput, getLiveUserInputIds } from '../../live-user-inputs'
import { logger } from '../../util/logger'
import { saveMessage } from '../message-cost-tracker'
import { openRouterLanguageModel } from '../openrouter'
import { vertexFinetuned } from './vertex-finetuned'

import type {
  GeminiModel,
  Model,
  OpenAIModel,
} from '@codebuff/common/old-constants'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type {
  OpenRouterProviderOptions,
  OpenRouterUsageAccounting,
} from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type { z } from 'zod/v4'

// User API keys for BYOK (Bring Your Own Key)
export interface UserApiKeys {
  anthropic?: string
  gemini?: string
  openai?: string
}

export type ByokMode = 'disabled' | 'prefer' | 'require'

export type StreamChunk =
  | {
    type: 'text'
    text: string
  }
  | {
    type: 'reasoning'
    text: string
  }
  | { type: 'error'; message: string }

/**
 * Helper function to determine if a model is an Anthropic model
 */
function isAnthropicModel(model: Model): boolean {
  return model.startsWith('anthropic/')
}

/**
 * Helper function to determine which provider key was used for BYOK
 */
function determineByokProvider(
  model: Model,
  userApiKeys?: UserApiKeys,
): 'anthropic' | 'gemini' | 'openai' | null {
  if (isAnthropicModel(model) && userApiKeys?.anthropic) return 'anthropic'
  if (Object.values(geminiModels).includes(model as GeminiModel) && userApiKeys?.gemini) return 'gemini'
  if (Object.values(openaiModels).includes(model as OpenAIModel) && userApiKeys?.openai) return 'openai'
  return null
}

/**
 * Convert a model string to an AI SDK LanguageModel instance.
 * Supports BYOK (Bring Your Own Key) for Anthropic, Gemini, and OpenAI.
 */
const modelToAiSDKModel = (
  model: Model,
  userApiKeys?: UserApiKeys,
  byokMode: ByokMode = 'prefer',
): LanguageModel => {
  // Finetuned Vertex models
  if (
    Object.values(finetunedVertexModels as Record<string, string>).includes(
      model,
    )
  ) {
    return vertexFinetuned(model)
  }

  // Gemini models - direct to Google
  if (Object.values(geminiModels).includes(model as GeminiModel)) {
    const apiKey =
      byokMode === 'disabled'
        ? env.GEMINI_API_KEY
        : userApiKeys?.gemini ?? env.GEMINI_API_KEY

    if (byokMode === 'require' && !userApiKeys?.gemini) {
      throw new Error('Gemini API key required but not provided (byokMode: require)')
    }

    return google.languageModel(model, { apiKey })
  }

  // OpenAI models - direct to OpenAI
  if (model === openaiModels.o3pro || model === openaiModels.o3) {
    const apiKey =
      byokMode === 'disabled'
        ? env.OPENAI_API_KEY
        : userApiKeys?.openai ?? env.OPENAI_API_KEY

    if (byokMode === 'require' && !userApiKeys?.openai) {
      throw new Error('OpenAI API key required but not provided (byokMode: require)')
    }

    return openai.responses(model, { apiKey })
  }

  if (Object.values(openaiModels).includes(model as OpenAIModel)) {
    const apiKey =
      byokMode === 'disabled'
        ? env.OPENAI_API_KEY
        : userApiKeys?.openai ?? env.OPENAI_API_KEY

    if (byokMode === 'require' && !userApiKeys?.openai) {
      throw new Error('OpenAI API key required but not provided (byokMode: require)')
    }

    return openai.languageModel(model, { apiKey })
  }

  // Anthropic models - direct to Anthropic (if user key provided) or OpenRouter
  if (isAnthropicModel(model)) {
    // If user has Anthropic key and byokMode allows it, use direct Anthropic API
    if (byokMode !== 'disabled' && userApiKeys?.anthropic) {
      const anthropic = createAnthropic({ apiKey: userApiKeys.anthropic })
      return anthropic.languageModel(model)
    }

    // If byokMode is 'require', fail if no user key
    if (byokMode === 'require') {
      throw new Error('Anthropic API key required but not provided (byokMode: require)')
    }

    // Otherwise, use OpenRouter with system key
    return openRouterLanguageModel(model)
  }

  // All other models go through OpenRouter with system key
  return openRouterLanguageModel(model)
}

// TODO: Add retries & fallbacks: likely by allowing this to instead of "model"
// also take an array of form [{model: Model, retries: number}, {model: Model, retries: number}...]
// eg: [{model: "gemini-2.0-flash-001"}, {model: "vertex/gemini-2.0-flash-001"}, {model: "claude-3-5-haiku", retries: 3}]
export const promptAiSdkStream = async function* (
  options: {
    messages: Message[]
    clientSessionId: string
    fingerprintId: string
    model: Model
    userId: string | undefined
    chargeUser?: boolean
    thinkingBudget?: number
    userInputId: string
    agentId?: string
    maxRetries?: number
    onCostCalculated?: (credits: number) => Promise<void>
    includeCacheControl?: boolean
    userApiKeys?: UserApiKeys
    byokMode?: ByokMode
  } & Omit<Parameters<typeof streamText>[0], 'model' | 'messages'>,
): AsyncGenerator<StreamChunk, string | null> {
  if (
    !checkLiveUserInput(
      options.userId,
      options.userInputId,
      options.clientSessionId,
    )
  ) {
    logger.info(
      {
        userId: options.userId,
        userInputId: options.userInputId,
        liveUserInputId: getLiveUserInputIds(options.userId),
      },
      'Skipping stream due to canceled user input',
    )
    return null
  }
  const startTime = Date.now()

  const byokMode = options.byokMode ?? 'prefer'
  let aiSDKModel = modelToAiSDKModel(options.model, options.userApiKeys, byokMode)

  const response = streamText({
    ...options,
    model: aiSDKModel,
    messages: convertCbToModelMessages(options),
  })

  let content = ''
  const stopSequenceHandler = new StopSequenceHandler(options.stopSequences)

  for await (const chunk of response.fullStream) {
    if (chunk.type !== 'text-delta') {
      const flushed = stopSequenceHandler.flush()
      if (flushed) {
        content += flushed
        yield {
          type: 'text',
          text: flushed,
        }
      }
    }
    if (chunk.type === 'error') {
      logger.error(
        {
          chunk: { ...chunk, error: undefined },
          error: errorToObject(chunk.error),
          model: options.model,
        },
        'Error from AI SDK',
      )

      const errorBody = APICallError.isInstance(chunk.error)
        ? chunk.error.responseBody
        : undefined
      const mainErrorMessage =
        chunk.error instanceof Error
          ? chunk.error.message
          : typeof chunk.error === 'string'
            ? chunk.error
            : JSON.stringify(chunk.error)
      const errorMessage = `Error from AI SDK (model ${options.model}): ${buildArray([mainErrorMessage, errorBody]).join('\n')}`
      yield {
        type: 'error',
        message: errorMessage,
      }

      return null
    }
    if (chunk.type === 'reasoning-delta') {
      if (
        (
          options.providerOptions?.openrouter as
          | OpenRouterProviderOptions
          | undefined
        )?.reasoning?.exclude
      ) {
        continue
      }
      yield {
        type: 'reasoning',
        text: chunk.text,
      }
    }
    if (chunk.type === 'text-delta') {
      if (!options.stopSequences) {
        content += chunk.text
        if (chunk.text) {
          yield {
            type: 'text',
            text: chunk.text,
          }
        }
        continue
      }

      const stopSequenceResult = stopSequenceHandler.process(chunk.text)
      if (stopSequenceResult.text) {
        content += stopSequenceResult.text
        yield {
          type: 'text',
          text: stopSequenceResult.text,
        }
      }
    }
  }
  const flushed = stopSequenceHandler.flush()
  if (flushed) {
    content += flushed
    yield {
      type: 'text',
      text: flushed,
    }
  }

  const providerMetadata = (await response.providerMetadata) ?? {}
  const usage = await response.usage
  let inputTokens = usage.inputTokens || 0
  const outputTokens = usage.outputTokens || 0
  let cacheReadInputTokens: number = 0
  let cacheCreationInputTokens: number = 0
  let costOverrideDollars: number | undefined
  if (providerMetadata.anthropic) {
    cacheReadInputTokens =
      typeof providerMetadata.anthropic.cacheReadInputTokens === 'number'
        ? providerMetadata.anthropic.cacheReadInputTokens
        : 0
    cacheCreationInputTokens =
      typeof providerMetadata.anthropic.cacheCreationInputTokens === 'number'
        ? providerMetadata.anthropic.cacheCreationInputTokens
        : 0
  }
  if (providerMetadata.openrouter) {
    if (providerMetadata.openrouter.usage) {
      const openrouterUsage = providerMetadata.openrouter
        .usage as OpenRouterUsageAccounting
      cacheReadInputTokens =
        openrouterUsage.promptTokensDetails?.cachedTokens ?? 0
      inputTokens = openrouterUsage.promptTokens - cacheReadInputTokens

      costOverrideDollars =
        (openrouterUsage.cost ?? 0) +
        (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
    }
  }

  const messageId = (await response.response).id
  const byokProvider = determineByokProvider(options.model, options.userApiKeys)
  const creditsUsedPromise = saveMessage({
    messageId,
    userId: options.userId,
    clientSessionId: options.clientSessionId,
    fingerprintId: options.fingerprintId,
    userInputId: options.userInputId,
    model: options.model,
    request: options.messages,
    response: content,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    finishedAt: new Date(),
    latencyMs: Date.now() - startTime,
    chargeUser: options.chargeUser ?? true,
    byokProvider,
    costOverrideDollars,
    agentId: options.agentId,
  })

  // Call the cost callback if provided
  if (options.onCostCalculated) {
    const creditsUsed = await creditsUsedPromise
    await options.onCostCalculated(creditsUsed)
  }

  return messageId
}

// TODO: figure out a nice way to unify stream & non-stream versions maybe?
export const promptAiSdk = async function (
  options: {
    messages: Message[]
    clientSessionId: string
    fingerprintId: string
    userInputId: string
    model: Model
    userId: string | undefined
    chargeUser?: boolean
    agentId?: string
    onCostCalculated?: (credits: number) => Promise<void>
    includeCacheControl?: boolean
    maxRetries?: number
    userApiKeys?: UserApiKeys
    byokMode?: ByokMode
  } & Omit<Parameters<typeof generateText>[0], 'model' | 'messages'>,
): Promise<string> {
  if (
    !checkLiveUserInput(
      options.userId,
      options.userInputId,
      options.clientSessionId,
    )
  ) {
    logger.info(
      {
        userId: options.userId,
        userInputId: options.userInputId,
        liveUserInputId: getLiveUserInputIds(options.userId),
      },
      'Skipping prompt due to canceled user input',
    )
    return ''
  }

  const startTime = Date.now()
  const byokMode = options.byokMode ?? 'prefer'
  let aiSDKModel = modelToAiSDKModel(options.model, options.userApiKeys, byokMode)

  const response = await generateText({
    ...options,
    model: aiSDKModel,
    messages: convertCbToModelMessages(options),
  })
  const content = response.text
  const inputTokens = response.usage.inputTokens || 0
  const outputTokens = response.usage.inputTokens || 0

  const byokProvider = determineByokProvider(options.model, options.userApiKeys)
  const creditsUsedPromise = saveMessage({
    messageId: generateCompactId(),
    userId: options.userId,
    clientSessionId: options.clientSessionId,
    fingerprintId: options.fingerprintId,
    userInputId: options.userInputId,
    model: options.model,
    request: options.messages,
    response: content,
    inputTokens,
    outputTokens,
    finishedAt: new Date(),
    latencyMs: Date.now() - startTime,
    chargeUser: options.chargeUser ?? true,
    agentId: options.agentId,
    byokProvider,
  })

  // Call the cost callback if provided
  if (options.onCostCalculated) {
    const creditsUsed = await creditsUsedPromise
    await options.onCostCalculated(creditsUsed)
  }

  return content
}

// Copied over exactly from promptAiSdk but with a schema
export const promptAiSdkStructured = async function <T>(options: {
  messages: Message[]
  schema: z.ZodType<T>
  clientSessionId: string
  fingerprintId: string
  userInputId: string
  model: Model
  userId: string | undefined
  maxTokens?: number
  temperature?: number
  timeout?: number
  chargeUser?: boolean
  agentId?: string
  onCostCalculated?: (credits: number) => Promise<void>
  includeCacheControl?: boolean
  maxRetries?: number
  userApiKeys?: UserApiKeys
  byokMode?: ByokMode
}): Promise<T> {
  if (
    !checkLiveUserInput(
      options.userId,
      options.userInputId,
      options.clientSessionId,
    )
  ) {
    logger.info(
      {
        userId: options.userId,
        userInputId: options.userInputId,
        liveUserInputId: getLiveUserInputIds(options.userId),
      },
      'Skipping structured prompt due to canceled user input',
    )
    return {} as T
  }
  const startTime = Date.now()
  const byokMode = options.byokMode ?? 'prefer'
  let aiSDKModel = modelToAiSDKModel(options.model, options.userApiKeys, byokMode)

  const responsePromise = generateObject<z.ZodType<T>, 'object'>({
    ...options,
    model: aiSDKModel,
    output: 'object',
    messages: convertCbToModelMessages(options),
  })

  const response = await (options.timeout === undefined
    ? responsePromise
    : withTimeout(responsePromise, options.timeout))
  const content = response.object
  const inputTokens = response.usage.inputTokens || 0
  const outputTokens = response.usage.inputTokens || 0

  const byokProvider = determineByokProvider(options.model, options.userApiKeys)
  const creditsUsedPromise = saveMessage({
    messageId: generateCompactId(),
    userId: options.userId,
    clientSessionId: options.clientSessionId,
    fingerprintId: options.fingerprintId,
    userInputId: options.userInputId,
    model: options.model,
    request: options.messages,
    response: JSON.stringify(content),
    inputTokens,
    outputTokens,
    finishedAt: new Date(),
    latencyMs: Date.now() - startTime,
    chargeUser: options.chargeUser ?? true,
    agentId: options.agentId,
    byokProvider,
  })

  // Call the cost callback if provided
  if (options.onCostCalculated) {
    const creditsUsed = await creditsUsedPromise
    await options.onCostCalculated(creditsUsed)
  }

  return content
}
