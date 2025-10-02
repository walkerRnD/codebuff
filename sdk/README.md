# @codebuff/sdk

Official SDK for Codebuff - AI coding agent and framework

## Installation

```bash
npm install @codebuff/sdk
```

## Prerequisites

- Create a Codebuff account and get your [Codebuff API key here](https://www.codebuff.com/api-keys).

## Usage

### Basic Example

```typescript
import { CodebuffClient } from '@codebuff/sdk'

async function main() {
  const client = new CodebuffClient({
    // You need to pass in your own API key here.
    // Get one here: https://www.codebuff.com/api-keys
    apiKey: process.env.CODEBUFF_API_KEY,
    cwd: process.cwd(),
  })

  // First run
  const run1 = await client.run({
    // The agent id. Any agent on the store (https://codebuff.com/store)
    agent: 'codebuff/base@0.0.16',
    prompt: 'Create a simple calculator class',
    handleEvent: (event) => {
      // All events that happen during the run: agent start/finish, tool calls/results, text responses, errors.
      console.log('Codebuff Event', JSON.stringify(event))
    },
  })

  // Continue the same session with a follow-up
  const run2 = await client.run({
    agent: 'codebuff/base@0.0.16',
    prompt: 'Add unit tests for the calculator',
    previousRun: run1, // <-- this is where your next run differs from the previous run
    handleEvent: (event) => {
      console.log('Codebuff Event', JSON.stringify(event))
    },
  })
}

main()
```

### Example 2: Custom Agents and Tools

Here, we create a full agent and custom tools that can be reused between runs.

```typescript
import { z } from 'zod/v4'

import { CodebuffClient, getCustomToolDefinition } from '@codebuff/sdk'

import type { AgentDefinition } from '@codebuff/sdk'

async function main() {
  const client = new CodebuffClient({
    // Note: You need to pass in your own API key.
    // Get it here: https://www.codebuff.com/profile?tab=api-keys
    apiKey: process.env.CODEBUFF_API_KEY,
    // Optional directory agent runs from (if applicable).
    cwd: process.cwd(),
  })

  // Define your own custom agents!
  const myCustomAgent: AgentDefinition = {
    id: 'my-custom-agent',
    model: 'x-ai/grok-4-fast',
    displayName: 'Sentiment analyzer',
    toolNames: ['fetch_api_data'] // Defined below!
    instructionsPrompt: `
1. Describe the different sentiments in the given prompt.
2. Score the prompt along the following 5 dimensions:
  happiness, sadness, anger, fear, and surprise.`,
    // ... other AgentDefinition properties
  }

  // And define your own custom tools!
  const myCustomTool = getCustomToolDefinition({
    toolName: 'fetch_api_data',
    description: 'Fetch data from an API endpoint',
    inputSchema: z.object({
      url: z.url(),
      method: z.enum(['GET', 'POST']).default('GET'),
      headers: z.record(z.string(), z.string()).optional(),
    }),
    exampleInputs: [{ url: 'https://api.example.com/data', method: 'GET' }],
    execute: async ({ url, method, headers }) => {
      const response = await fetch(url, { method, headers })
      const data = await response.text()
      return [
        {
          type: 'json' as const,
          value: {
            message: `API Response: ${data.slice(0, 5000)}...`,
          },
        },
      ]
    },
  })

  const { output } = await client.run({
    // Run a custom agent by id. Must match an id in the agentDefinitions field below.
    agent: 'my-custom-agent',
    prompt: "Today I'm feeling very happy!",

    // Provide custom agent and tool definitions:
    agentDefinitions: [myCustomAgent],
    customToolDefinitions: [myCustomTool],

    handleEvent: (event) => {
      // All events that happen during the run: agent start/finish, tool calls/results, text responses, errors.
      console.log('Codebuff Event', JSON.stringify(event))
    },
  })

  if (output.type === 'error') {
    console.error(`The run failed:\n${output.message}`)
  } else {
    console.log('The run succeeded with output:', output)
  }
}

main()
```

### Example 3: Bring Your Own Key (BYOK)

Use your own API keys for Anthropic, Gemini, or OpenAI models to pay directly for LLM costs with reduced or zero Codebuff markup.

```typescript
import { CodebuffClient } from '@codebuff/sdk'

async function main() {
  const client = new CodebuffClient({
    // Option 1: Use only your provider keys (no Codebuff API key required)
    userApiKeys: {
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      openai: process.env.OPENAI_API_KEY,
    },
    byokMode: 'require', // Only use user keys, fail if missing
    cwd: process.cwd(),
  })

  // Option 2: Use Codebuff API key with provider keys as fallback
  const client2 = new CodebuffClient({
    apiKey: process.env.CODEBUFF_API_KEY,
    userApiKeys: {
      anthropic: process.env.ANTHROPIC_API_KEY,
    },
    byokMode: 'prefer', // Use user keys when available, fallback to system keys (default)
    cwd: process.cwd(),
  })

  // Option 3: Disable BYOK and always use system keys
  const client3 = new CodebuffClient({
    apiKey: process.env.CODEBUFF_API_KEY,
    byokMode: 'disabled', // Always use system keys
    cwd: process.cwd(),
  })

  const run = await client.run({
    agent: 'codebuff/base@0.0.16',
    prompt: 'Create a simple calculator class',
    handleEvent: (event) => {
      console.log('Codebuff Event', JSON.stringify(event))
    },
  })
}

main()
```

#### BYOK Modes

- **`'disabled'`**: Always use Codebuff's system keys. Requires a Codebuff API key.
- **`'prefer'`** (default): Use your provider keys when available, fallback to system keys. Recommended for most users.
- **`'require'`**: Only use your provider keys. No Codebuff API key required. Fails if provider key is missing for the selected model.

#### BYOK Benefits

- **Lower Costs**: Pay only the provider's API costs with reduced Codebuff markup
- **Direct Billing**: Charges appear directly on your provider account
- **No Codebuff API Key Required**: When using `byokMode: 'require'`, you can use Codebuff without a Codebuff API key
- **Provider Choice**: Use your preferred provider's billing and rate limits

#### Supported Providers

- **Anthropic**: Claude models (e.g., `anthropic/claude-3.5-sonnet`)
- **Google Gemini**: Gemini models (e.g., `gemini-2.0-flash-exp`)
- **OpenAI**: GPT models (e.g., `gpt-4o`, `o1`, `o3-mini`)

#### Security

- API keys are encrypted at rest using AES-256-GCM
- Keys are validated before storage
- Keys are never logged or exposed in error messages

## API Reference

### `new CodebuffClient(options)`

Creates a new Codebuff client instance.

#### Constructor Parameters

- **`apiKey`** (string, optional): Your Codebuff API key. Get one at [codebuff.com/api-keys](https://www.codebuff.com/api-keys). Optional if using `byokMode: 'require'` with provider keys.

- **`cwd`** (string, optional): Working directory for the agent. Defaults to `process.cwd()`.

- **`userApiKeys`** (object, optional): Your own API keys for AI providers. Enables BYOK (Bring Your Own Key) mode.
  - `anthropic` (string, optional): Anthropic API key (starts with `sk-ant-api03-`)
  - `gemini` (string, optional): Google Gemini API key (starts with `AIzaSy`)
  - `openai` (string, optional): OpenAI API key (starts with `sk-proj-`)

- **`byokMode`** (string, optional): Controls how user API keys are used. Defaults to `'prefer'`.
  - `'disabled'`: Always use Codebuff's system keys (requires Codebuff API key)
  - `'prefer'`: Use user keys when available, fallback to system keys (default)
  - `'require'`: Only use user keys, fail if missing (no Codebuff API key needed)

### `client.run(options)`

Runs a Codebuff agent with the specified options.

#### Parameters

- **`agent`** (string, required): The agent to run. Use `'base'` for the default agent, or specify a custom agent ID if you made your own agent definition (passed with the `agentDefinitions` param).

- **`prompt`** (string, required): The user prompt describing what you want the agent to do.

- **`params`** (object, optional): Additional parameters for the agent. Most agents don't use this, but some custom agents can take a JSON object as input in addition to the user prompt string.

- **`handleEvent`** (function, optional): Callback function that receives every event during execution (assistant messages, tool calls, etc.). This allows you to stream the agent's progress in real-time. We will likely add a token-by-token streaming callback in the future.

- **`previousRun`** (object, optional): JSON state returned from a previous `run()` call. Use this to continue a conversation or session with the agent, maintaining context from previous interactions.

- **`projectFiles`** (object, optional): All the files in your project as a plain JavaScript object. Keys should be the full path from your current directory to each file, and values should be the string contents of the file. Example: `{ "src/index.ts": "console.log('hi')" }`. This helps Codebuff pick good source files for context. Note: This parameter was previously named `allFiles` but has been renamed for clarity.

- **`knowledgeFiles`** (object, optional): Knowledge files to inject into every `run()` call. Uses the same schema as `projectFiles` - keys are file paths and values are file contents. These files are added directly to the agent's context.

- **`agentDefinitions`** (array, optional): Array of custom agent definitions. Each object should satisfy the AgentDefinition type.

- **`customToolDefinitions`** (array, optional): Array of custom tool definitions that extend the agent's capabilities. Each tool definition includes a name, Zod schema for input validation, and a handler function. These tools can be called by the agent during execution.

- **`maxAgentSteps`** (number, optional): Maximum number of steps the agent can take before stopping. Use this as a safety measure in case your agent starts going off the rails. A reasonable number is around 20.

#### Returns

Returns a Promise that resolves to a `RunState` object which can be passed into subsequent runs via the `previousRun` parameter to resume the conversation.

## License

MIT
