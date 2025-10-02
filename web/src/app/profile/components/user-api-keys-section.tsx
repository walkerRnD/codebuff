'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import { Check, X, AlertCircle, Key } from 'lucide-react'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { ProfileSection } from './profile-section'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface UserApiKey {
  type: string
  name: string
  configured: boolean
}

async function fetchUserApiKeys(): Promise<{ keys: UserApiKey[] }> {
  const res = await fetch('/api/user-api-keys')
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export function UserApiKeysSection() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const {
    data: keysData,
    isLoading: loadingKeys,
    error: keysError,
    refetch: refetchKeys,
  } = useQuery({
    queryKey: ['user-api-keys'],
    queryFn: fetchUserApiKeys,
  })

  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [keyValues, setKeyValues] = useState<Record<string, string>>({})
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
  const [keyToRemove, setKeyToRemove] = useState<string | null>(null)

  const saveKeyMutation = useMutation({
    mutationFn: async ({
      keyType,
      apiKey,
    }: {
      keyType: string
      apiKey: string
    }) => {
      const res = await fetch('/api/user-api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyType, apiKey }),
      })
      if (!res.ok) {
        const errorData = await res.json()
        throw new Error(errorData.message || errorData.error || 'Failed to save key')
      }
      return res.json()
    },
    onSuccess: async (data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['user-api-keys'] })
      setEditingKey(null)
      setKeyValues((prev) => ({ ...prev, [variables.keyType]: '' }))
      toast({ title: data.message || 'API key saved successfully' })
    },
    onError: (e: any) => {
      toast({
        title: 'Failed to save API key',
        description: e.message ?? String(e),
        variant: 'destructive' as any,
      })
    },
  })

  const removeKeyMutation = useMutation({
    mutationFn: async (keyType: string) => {
      const res = await fetch(`/api/user-api-keys/${keyType}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const errorData = await res.json()
        throw new Error(errorData.message || errorData.error || 'Failed to remove key')
      }
      return res.json()
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['user-api-keys'] })
      setRemoveDialogOpen(false)
      setKeyToRemove(null)
      toast({ title: data.message || 'API key removed successfully' })
    },
    onError: (e: any) => {
      toast({
        title: 'Failed to remove API key',
        description: e.message ?? String(e),
        variant: 'destructive' as any,
      })
    },
  })

  const handleSave = (keyType: string) => {
    const apiKey = keyValues[keyType]
    if (!apiKey || apiKey.trim() === '') {
      toast({
        title: 'Invalid input',
        description: 'Please enter an API key',
        variant: 'destructive' as any,
      })
      return
    }
    saveKeyMutation.mutate({ keyType, apiKey })
  }

  const handleRemove = (keyType: string) => {
    setKeyToRemove(keyType)
    setRemoveDialogOpen(true)
  }

  const confirmRemove = () => {
    if (keyToRemove) {
      removeKeyMutation.mutate(keyToRemove)
    }
  }

  const getKeyPlaceholder = (keyType: string) => {
    switch (keyType) {
      case 'anthropic':
        return 'sk-ant-api03-...'
      case 'gemini':
        return 'AIzaSy...'
      case 'openai':
        return 'sk-proj-...'
      default:
        return 'Enter your API key'
    }
  }

  const getKeyDescription = (keyType: string) => {
    switch (keyType) {
      case 'anthropic':
        return 'Use your own Anthropic API key for Claude models. Get one at console.anthropic.com'
      case 'gemini':
        return 'Use your own Google API key for Gemini models. Get one at aistudio.google.com'
      case 'openai':
        return 'Use your own OpenAI API key for GPT models. Get one at platform.openai.com'
      default:
        return 'Use your own API key for this provider'
    }
  }

  return (
    <ProfileSection description="Configure your own API keys for AI providers. Your keys are encrypted and stored securely.">
      <Alert className="mb-6">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          <strong>Bring Your Own Key (BYOK):</strong> When you provide your own
          API keys, you pay only for actual API usage through your provider
          accounts. Codebuff applies a reduced markup compared to using our
          system keys. Your keys are encrypted at rest using AES-256-GCM.
        </AlertDescription>
      </Alert>

      {keysError && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Error loading API keys: {(keysError as any)?.message ?? 'Please try again.'}
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchKeys()}
              className="ml-2"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loadingKeys ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-6 bg-gray-200 rounded w-1/3"></div>
              </CardHeader>
              <CardContent>
                <div className="h-10 bg-gray-200 rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {keysData?.keys.map((key) => (
            <Card key={key.type}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Key className="h-5 w-5" />
                    <CardTitle>{key.name}</CardTitle>
                    {key.configured && (
                      <span className="flex items-center gap-1 text-sm text-green-600">
                        <Check className="h-4 w-4" />
                        Configured
                      </span>
                    )}
                  </div>
                  {key.configured && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemove(key.type)}
                      disabled={removeKeyMutation.isPending}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Remove
                    </Button>
                  )}
                </div>
                <CardDescription>{getKeyDescription(key.type)}</CardDescription>
              </CardHeader>
              <CardContent>
                {key.configured && editingKey !== key.type ? (
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      value="••••••••••••••••••••••••••••••••"
                      readOnly
                      className="flex-1"
                    />
                    <Button
                      variant="outline"
                      onClick={() => setEditingKey(key.type)}
                    >
                      Update
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor={`key-${key.type}`}>API Key</Label>
                    <div className="flex gap-2">
                      <Input
                        id={`key-${key.type}`}
                        type="password"
                        placeholder={getKeyPlaceholder(key.type)}
                        value={keyValues[key.type] || ''}
                        onChange={(e) =>
                          setKeyValues((prev) => ({
                            ...prev,
                            [key.type]: e.target.value,
                          }))
                        }
                        className="flex-1"
                      />
                      <Button
                        onClick={() => handleSave(key.type)}
                        disabled={
                          saveKeyMutation.isPending ||
                          !keyValues[key.type] ||
                          keyValues[key.type].trim() === ''
                        }
                      >
                        {saveKeyMutation.isPending ? 'Saving...' : 'Save'}
                      </Button>
                      {editingKey === key.type && (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setEditingKey(null)
                            setKeyValues((prev) => ({ ...prev, [key.type]: '' }))
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmationDialog
        isOpen={removeDialogOpen}
        onOpenChange={setRemoveDialogOpen}
        title="Remove API Key?"
        description="Are you sure you want to remove this API key? You will need to re-enter it if you want to use it again."
        onConfirm={confirmRemove}
        isConfirming={removeKeyMutation.isPending}
        confirmButtonText="Remove"
      />
    </ProfileSection>
  )
}

