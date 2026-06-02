import OpenAI from 'openai'

const VENICE_BASE_URL = 'https://api.venice.ai/api/v1'
const VENICE_CHAT_MODEL = 'qwen3-6-27b'
const VENICE_EMBED_MODEL = 'text-embedding-3-large'
const VENICE_IMAGE_MODEL = 'flux-dev'
const VENICE_AUDIO_TTS_MODEL = 'tts-kokoro'
const VENICE_CRYPTO_RPC_BASE = 'https://api.venice.ai/api/v1/crypto/rpc'

const VENICE_SUPPORTED_CHAINS = [
  'base-mainnet', 'ethereum-mainnet', 'arbitrum-mainnet', 'optimism-mainnet',
  'polygon-mainnet', 'bsc-mainnet', 'avalanche-mainnet', 'fantom-mainnet',
  'gnosis-mainnet', 'celo-mainnet', 'solana-mainnet',
] as const

export type VeniceChain = typeof VENICE_SUPPORTED_CHAINS[number]

let veniceClient: OpenAI | null = null

function getVeniceClient(): OpenAI {
  if (!veniceClient) {
    const key = process.env.VENICE_API_KEY
    if (!key) throw new Error('VENICE_API_KEY not set')
    veniceClient = new OpenAI({ apiKey: key, baseURL: VENICE_BASE_URL })
  }
  return veniceClient
}

export interface VeniceChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
  enableWebSearch?: boolean | 'auto'
  enableWebScraping?: boolean
}

export async function veniceChat(
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  options: VeniceChatOptions = {},
): Promise<{ reply: string; tokensUsed: number; provider: string }> {
  const client = getVeniceClient()

  const body: Record<string, unknown> = {
    model: options.model || VENICE_CHAT_MODEL,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 2048,
  }

  if (options.enableWebSearch) {
    body.venice_parameters = {
      ...(body.venice_parameters as Record<string, unknown> || {}),
      enable_web_search: options.enableWebSearch === true ? 'always' : options.enableWebSearch,
    }
  }
  if (options.enableWebScraping) {
    body.venice_parameters = {
      ...(body.venice_parameters as Record<string, unknown> || {}),
      enable_web_scraping: true,
    }
  }

  const completion = await (client.chat.completions.create as Function)(body)
  const reply = completion.choices[0]?.message?.content?.trim() || ''
  const tokensUsed = (completion.usage?.prompt_tokens || 0) + (completion.usage?.completion_tokens || 0)
  return { reply, tokensUsed, provider: 'venice' }
}

export async function veniceEmbed(texts: string[]): Promise<number[][]> {
  const client = getVeniceClient()
  const response = await client.embeddings.create({
    model: VENICE_EMBED_MODEL,
    input: texts,
  })
  return response.data.map(d => d.embedding)
}

export async function veniceImageGenerate(prompt: string): Promise<string | null> {
  const client = getVeniceClient()
  const response = await client.images.generate({
    model: VENICE_IMAGE_MODEL,
    prompt,
    size: '1024x1024',
    n: 1,
  })
  const img = response.data?.[0]
  return img?.url || img?.b64_json || null
}

export async function veniceCryptoRpc(
  method: string,
  params: unknown[] = [],
  chain: VeniceChain = 'base-mainnet',
): Promise<unknown> {
  const key = process.env.VENICE_API_KEY
  if (!key) throw new Error('VENICE_API_KEY not set')

  const rpcUrl = `${VENICE_CRYPTO_RPC_BASE}/${chain}`
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })

  const data = await res.json()
  if (data.error) throw new Error(`RPC error (${chain}): ${data.error.message}`)
  return data.result
}

export async function veniceAudioTTS(
  text: string,
  voice: string = 'af_sky',
): Promise<Buffer | null> {
  const key = process.env.VENICE_API_KEY
  if (!key) throw new Error('VENICE_API_KEY not set')

  const res = await fetch(`${VENICE_BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VENICE_AUDIO_TTS_MODEL,
      input: text.slice(0, 4096),
      voice,
    }),
  })

  if (!res.ok) {
    console.error(`[Venice TTS] Error ${res.status}: ${await res.text()}`)
    return null
  }

  const arrayBuf = await res.arrayBuffer()
  return Buffer.from(arrayBuf)
}

export async function veniceWebSearch(
  query: string,
): Promise<{ reply: string; tokensUsed: number; provider: string }> {
  return veniceChat(
    [{ role: 'user', content: query }],
    { enableWebSearch: 'auto', maxTokens: 2048 },
  )
}

export { VENICE_SUPPORTED_CHAINS }

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
