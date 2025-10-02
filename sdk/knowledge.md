# Codebuff SDK Knowledge Base

## Architecture Overview

The Codebuff SDK provides a TypeScript/JavaScript interface to the Codebuff AI coding agent platform. It handles communication with the Codebuff backend via WebSocket connections, manages agent state, and provides a simple API for running AI agents with custom tools.

## BYOK (Bring Your Own Key) Architecture

### Overview

BYOK allows SDK users to provide their own API keys for Anthropic, Gemini, and OpenAI models. This enables users to:
- Pay directly for LLM API costs through their provider accounts
- Benefit from reduced or zero Codebuff markup
- Use Codebuff's agent infrastructure without a Codebuff API key (in `require` mode)

### Key Components

#### 1. SDK Layer (`sdk/src/`)

**`client.ts`**: 
- Accepts `userApiKeys` and `byokMode` in constructor options
- Validates authentication based on byokMode:
  - `disabled`: Requires Codebuff API key
  - `prefer`: Accepts either Codebuff API key or user keys
  - `require`: Requires at least one user API key (no Codebuff key needed)

**`run.ts`**:
- Passes `userApiKeys` and `byokMode` through WebSocket connection
- Includes these parameters in the CLIENT_ACTION_SCHEMA

**`websocket-client.ts`**:
- Transmits user keys and mode to backend via WebSocket messages

#### 2. Common Layer (`common/src/`)

**`actions.ts`**:
- Defines CLIENT_ACTION_SCHEMA with optional `userApiKeys` and `byokMode` fields
- Validates action payloads before transmission

**`api-keys/crypto.ts`**:
- `validateApiKey()`: Validates API key format (prefix and length)
- `encryptAndStoreApiKey()`: Encrypts keys using AES-256-GCM before storage
- `retrieveAndDecryptApiKey()`: Retrieves and decrypts keys from database
- `clearApiKey()`: Removes keys from database

#### 3. Web Layer (`web/src/`)

**`app/api/user-api-keys/route.ts`**:
- GET: Returns list of configured key types for authenticated user
- POST: Validates and stores encrypted API keys

**`app/api/user-api-keys/[keyType]/route.ts`**:
- DELETE: Removes specific API key for authenticated user

**`app/profile/components/user-api-keys-section.tsx`**:
- React component for managing provider API keys
- Card-based UI for each provider (Anthropic, Gemini, OpenAI)
- Shows configuration status, masked keys, input fields
- Handles save/update/remove operations

#### 4. Backend Layer (`backend/src/`)

**`main-prompt.ts`**:
- `getUserApiKeys()`: Retrieves user keys from database and merges with SDK-provided keys
- Key precedence: SDK keys > DB keys > system keys
- Passes merged keys to agent execution pipeline

**`llm-apis/vercel-ai-sdk/ai-sdk.ts`**:
- `modelToAiSDKModel()`: Routes models to appropriate provider based on BYOK configuration
- `isAnthropicModel()`: Identifies Anthropic models
- `determineByokProvider()`: Determines which provider key was used
- Direct-to-provider routing:
  - Anthropic models with user key → `@ai-sdk/anthropic`
  - Gemini models with user key → `@ai-sdk/google`
  - OpenAI models with user key → `@ai-sdk/openai`
  - Models without user keys → OpenRouter (system keys)

**`llm-apis/message-cost-tracker.ts`**:
- `saveMessage()`: Tracks costs per provider
- Applies reduced markup for BYOK usage: `PROFIT_MARGIN` vs `1 + PROFIT_MARGIN`
- `byokProvider` field indicates which provider key was used

**`run-agent-step.ts`**:
- `loopAgentSteps()`: Passes BYOK parameters through agent execution loop

**`prompt-agent-stream.ts`**:
- `getAgentStreamFromTemplate()`: Passes BYOK parameters to AI SDK functions

### Data Flow

1. **SDK Initialization**:
   ```
   User → CodebuffClient(userApiKeys, byokMode) → Validation
   ```

2. **Run Execution**:
   ```
   client.run() → WebSocket → Backend → getUserApiKeys() → Merge Keys
   ```

3. **Model Routing**:
   ```
   Model Selection → modelToAiSDKModel(model, userApiKeys, byokMode)
   → Direct Provider API or OpenRouter
   ```

4. **Cost Tracking**:
   ```
   API Response → determineByokProvider() → saveMessage(byokProvider)
   → Reduced Markup Calculation
   ```

### Key Precedence

When determining which API key to use:
1. **SDK-provided keys** (passed in `client.run()` or constructor)
2. **Database keys** (stored via web UI)
3. **System keys** (Codebuff's keys)

This allows users to override database keys on a per-run basis.

### Security Considerations

1. **Encryption**: All user API keys are encrypted at rest using AES-256-GCM
2. **Validation**: Keys are validated for correct format before storage
3. **No Logging**: Keys are never logged or exposed in error messages
4. **Secure Transmission**: Keys are transmitted over secure WebSocket connections
5. **Database Storage**: Keys stored in `encrypted_api_keys` table with composite primary key (user_id, type)

### Provider Routing

#### Anthropic Models
- **With User Key**: Direct to Anthropic API via `@ai-sdk/anthropic`
- **Without User Key**: Through OpenRouter with system keys
- **Model Format**: `anthropic/claude-3.5-sonnet`, etc.

#### Gemini Models
- **With User Key**: Direct to Google API via `@ai-sdk/google`
- **Without User Key**: System Gemini key
- **Model Format**: `gemini-2.0-flash-exp`, etc.

#### OpenAI Models
- **With User Key**: Direct to OpenAI API via `@ai-sdk/openai`
- **Without User Key**: System OpenAI key
- **Model Format**: `gpt-4o`, `o1`, `o3-mini`, etc.

### Cost Calculation

```typescript
// Without BYOK (system keys)
costInCents = cost * 100 * (1 + PROFIT_MARGIN)

// With BYOK (user keys)
costInCents = cost * 100 * PROFIT_MARGIN
```

The reduced markup for BYOK reflects that users are paying for the LLM API costs directly.

### Error Handling

#### `byokMode: 'require'`
- Throws error if no user key available for selected model
- Example: "Anthropic API key required but not provided (byokMode: require)"

#### `byokMode: 'prefer'`
- Falls back to system keys if user key unavailable
- No error thrown

#### `byokMode: 'disabled'`
- Always uses system keys
- Requires Codebuff API key

### Database Schema

```sql
CREATE TABLE encrypted_api_keys (
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'anthropic' | 'gemini' | 'openai'
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, type)
);
```

### API Key Validation

Each provider has specific validation rules:

- **Anthropic**: Prefix `sk-ant-api03-`, length 108
- **Gemini**: Prefix `AIzaSy`, length 39
- **OpenAI**: Prefix `sk-proj-`, length 164

### Future Enhancements

Potential improvements to the BYOK system:
1. Support for additional providers (Azure OpenAI, AWS Bedrock, etc.)
2. Per-model key configuration
3. Key rotation and expiration
4. Usage analytics per provider
5. Cost alerts and budgets
6. Key sharing within organizations

## Testing BYOK

### Unit Tests
- Test key validation logic
- Test encryption/decryption
- Test key precedence

### Integration Tests
- Test end-to-end flow with real provider keys
- Test fallback behavior
- Test error handling for missing keys

### Manual Testing
1. Configure keys via web UI
2. Run agent with different byokMode settings
3. Verify correct provider routing
4. Check cost calculations
5. Test key removal and updates

