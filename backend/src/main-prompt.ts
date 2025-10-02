import { AgentTemplateTypes } from '@codebuff/common/types/session-state'
import { generateCompactId } from '@codebuff/common/util/string'
import { uniq } from 'lodash'

import { checkTerminalCommand } from './check-terminal-command'
import { loopAgentSteps } from './run-agent-step'
import { getAgentTemplate } from './templates/agent-registry'
import { logger } from './util/logger'
import { expireMessages } from './util/messages'
import { requestToolCall } from './websockets/websocket-action'
import { retrieveAndDecryptApiKey } from '@codebuff/common/api-keys/crypto'

import type { AgentTemplate } from './templates/types'
import type { ClientAction } from '@codebuff/common/actions'
import type { CostMode } from '@codebuff/common/old-constants'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type {
  SessionState,
  AgentTemplateType,
  AgentOutput,
} from '@codebuff/common/types/session-state'
import type { WebSocket } from 'ws'
import type { UserApiKeys, ByokMode } from './llm-apis/vercel-ai-sdk/ai-sdk'

export interface MainPromptOptions {
  userId: string | undefined
  clientSessionId: string
  onResponseChunk: (chunk: string | PrintModeEvent) => void
  localAgentTemplates: Record<string, AgentTemplate>
}

/**
 * Retrieves user API keys from the database for BYOK (Bring Your Own Key)
 * Merges SDK-provided keys with database keys, with SDK keys taking precedence
 */
async function getUserApiKeys(
  userId: string | undefined,
  sdkKeys?: UserApiKeys,
): Promise<UserApiKeys | undefined> {
  if (!userId) {
    return sdkKeys
  }

  try {
    // Retrieve keys from database
    const [anthropicKey, geminiKey, openaiKey] = await Promise.all([
      retrieveAndDecryptApiKey(userId, 'anthropic'),
      retrieveAndDecryptApiKey(userId, 'gemini'),
      retrieveAndDecryptApiKey(userId, 'openai'),
    ])

    // Merge with SDK keys (SDK keys take precedence)
    return {
      anthropic: sdkKeys?.anthropic ?? anthropicKey ?? undefined,
      gemini: sdkKeys?.gemini ?? geminiKey ?? undefined,
      openai: sdkKeys?.openai ?? openaiKey ?? undefined,
    }
  } catch (error) {
    logger.error({ error, userId }, 'Failed to retrieve user API keys')
    return sdkKeys
  }
}

export const mainPrompt = async (
  ws: WebSocket,
  action: ClientAction<'prompt'>,
  options: MainPromptOptions,
): Promise<{
  sessionState: SessionState
  output: AgentOutput
}> => {
  const { userId, clientSessionId, onResponseChunk, localAgentTemplates } =
    options

  const {
    prompt,
    content,
    sessionState: sessionState,
    fingerprintId,
    costMode,
    promptId,
    agentId,
    promptParams,
    userApiKeys: sdkUserApiKeys,
    byokMode,
  } = action
  const { fileContext, mainAgentState } = sessionState

  // Retrieve and merge user API keys (SDK keys take precedence over DB keys)
  const userApiKeys = await getUserApiKeys(userId, sdkUserApiKeys)

  if (prompt) {
    // Check if this is a direct terminal command
    const startTime = Date.now()
    const terminalCommand = await checkTerminalCommand(prompt, {
      clientSessionId,
      fingerprintId,
      userInputId: promptId,
      userId,
    })
    const duration = Date.now() - startTime

    if (terminalCommand) {
      logger.debug(
        {
          duration,
          prompt,
        },
        `Detected terminal command in ${duration}ms, executing directly: ${prompt}`,
      )

      const { output } = await requestToolCall(
        ws,
        promptId,
        'run_terminal_command',
        {
          command: terminalCommand,
          mode: 'user',
          process_type: 'SYNC',
          timeout_seconds: -1,
        },
      )

      mainAgentState.messageHistory.push({
        role: 'tool',
        content: {
          type: 'tool-result',
          toolName: 'run_terminal_command',
          toolCallId: generateCompactId(),
          output: output,
        },
      })

      const newSessionState = {
        ...sessionState,
        messageHistory: expireMessages(
          mainAgentState.messageHistory,
          'userPrompt',
        ),
      }

      return {
        sessionState: newSessionState,
        output: {
          type: 'lastMessage',
          value: output,
        },
      }
    }
  }

  const availableAgents = Object.keys(localAgentTemplates)

  // Determine agent type - prioritize CLI agent selection, then config base agent, then cost mode
  let agentType: AgentTemplateType

  if (agentId) {
    if (!(await getAgentTemplate(agentId, localAgentTemplates))) {
      throw new Error(
        `Invalid agent ID: "${agentId}". Available agents: ${availableAgents.join(', ')}`,
      )
    }

    agentType = agentId
    logger.info(
      {
        agentId,
        promptParams,
        prompt: prompt?.slice(0, 50),
      },
      `Using CLI-specified agent: ${agentId}`,
    )
  } else {
    // Check for base agent in config
    const configBaseAgent = fileContext.codebuffConfig?.baseAgent
    if (configBaseAgent) {
      if (!(await getAgentTemplate(configBaseAgent, localAgentTemplates))) {
        throw new Error(
          `Invalid base agent in config: "${configBaseAgent}". Available agents: ${availableAgents.join(', ')}`,
        )
      }
      agentType = configBaseAgent
      logger.info(
        {
          configBaseAgent,
          promptParams,
          prompt: prompt?.slice(0, 50),
        },
        `Using config-specified base agent: ${configBaseAgent}`,
      )
    } else {
      // Fall back to cost mode mapping
      agentType = (
        {
          ask: AgentTemplateTypes.ask,
          lite: AgentTemplateTypes.base_lite,
          normal: AgentTemplateTypes.base,
          max: AgentTemplateTypes.base_max,
          experimental: 'base2',
        } satisfies Record<CostMode, AgentTemplateType>
      )[costMode]
    }
  }

  mainAgentState.agentType = agentType

  let mainAgentTemplate = await getAgentTemplate(agentType, localAgentTemplates)
  if (!mainAgentTemplate) {
    throw new Error(`Agent template not found for type: ${agentType}`)
  }

  let updatedSubagents = mainAgentTemplate.spawnableAgents
  if (!agentId) {
    // If --agent is not specified, use the spawnableAgents from the codebuff config or add all local agents
    const {
      spawnableAgents,
      addedSpawnableAgents = [],
      removedSpawnableAgents = [],
    } = fileContext.codebuffConfig ?? {}
    updatedSubagents =
      spawnableAgents ??
      uniq([...mainAgentTemplate.spawnableAgents, ...availableAgents])

    updatedSubagents = uniq([
      ...updatedSubagents,
      ...addedSpawnableAgents,
    ]).filter((subagent) => !removedSpawnableAgents.includes(subagent))
  }
  mainAgentTemplate.spawnableAgents = updatedSubagents
  localAgentTemplates[agentType] = mainAgentTemplate

  const { agentState, output } = await loopAgentSteps(ws, {
    userInputId: promptId,
    prompt,
    content,
    params: promptParams,
    agentType,
    agentState: mainAgentState,
    fingerprintId,
    fileContext,
    userId,
    clientSessionId,
    onResponseChunk,
    localAgentTemplates,
    userApiKeys,
    byokMode,
  })

  logger.debug({ agentState, output }, 'Main prompt finished')

  return {
    sessionState: {
      fileContext,
      mainAgentState: agentState,
    },
    output: output ?? {
      type: 'error' as const,
      message: 'No output from agent',
    },
  }
}
