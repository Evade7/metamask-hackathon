const RELAYER_URL = 'https://relayer.1shotapi.com/relayers'
const BASE_CHAIN_ID = '8453'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

interface FeeData {
  gasPrice: string
  rate: string
  minFee: string
  expiry: number
  context: string
}

interface RelayResult {
  taskId: string
}

interface RelayStatus {
  taskId: string
  status: 'Pending' | 'Confirmed' | 'Rejected' | 'Reverted'
  txHash?: string
  blockNumber?: number
}

async function rpcCall(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(RELAYER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  const data = await res.json()
  if (data.error) throw new Error(`1Shot RPC error: ${JSON.stringify(data.error)}`)
  return data.result
}

export async function getCapabilities(): Promise<unknown> {
  return rpcCall('relayer_getCapabilities', [BASE_CHAIN_ID])
}

export async function getFeeData(): Promise<FeeData> {
  const result = await rpcCall('relayer_getFeeData', {
    chainId: BASE_CHAIN_ID,
    token: USDC_BASE,
  })
  return result as FeeData
}

export async function relayTransaction(params: {
  context: string
  transaction: Record<string, unknown>
  authorizations?: Record<string, unknown>[]
  delegation?: Record<string, unknown>
}): Promise<RelayResult> {
  const result = await rpcCall('relayer_send7710Transaction', {
    chainId: BASE_CHAIN_ID,
    context: params.context,
    transaction: params.transaction,
    authorizations: params.authorizations || [],
    delegation: params.delegation || {},
  })
  return result as RelayResult
}

export async function getRelayStatus(taskIds: string[]): Promise<RelayStatus[]> {
  const result = await rpcCall('relayer_getStatus', taskIds)
  return result as RelayStatus[]
}

export async function relayDelegationRedemption(params: {
  delegationChain: Record<string, unknown>[]
  executionCalldata: `0x${string}`
  eip7702Auth?: Record<string, unknown>
}): Promise<{ taskId: string; feeContext: string }> {
  const fee = await getFeeData()

  const result = await relayTransaction({
    context: fee.context,
    transaction: {
      delegationChain: params.delegationChain,
      executionCalldata: params.executionCalldata,
    },
    authorizations: params.eip7702Auth ? [params.eip7702Auth] : [],
  })

  return { taskId: result.taskId, feeContext: fee.context }
}
