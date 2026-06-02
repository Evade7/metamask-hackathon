const RELAYER_URL = 'https://relayer.1shotapi.com/relayers'
const BASE_CHAIN_ID = '8453'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

interface FeeData {
  gasPrice: string
  rate: string
  minFee: string
  expiry: number
  context: string
  feeCollector: string
  targetAddress: string
}

interface RelayStatus {
  id: string
  chainId: string
  status: number
  createdAt: string
  hash?: string
  receipt?: {
    blockHash: string
    blockNumber: number
    gasUsed: string
    transactionHash: string
  }
  message?: string
  memo?: string
}

// ─── In-memory relay task store ───

export type RelayTaskStatus = 'pending' | 'submitted' | 'confirmed' | 'failed'

export interface RelayTask {
  taskId: string
  type: '7702' | '7710'
  status: RelayTaskStatus
  txHash: string | null
  blockNumber: number | null
  address: string
  error: string | null
  createdAt: number
  updatedAt: number
}

const relayTasks = new Map<string, RelayTask>()

export function storeRelayTask(task: RelayTask): void {
  relayTasks.set(task.taskId, task)
  console.log(`[1Shot] Task stored: ${task.taskId} type=${task.type} address=${task.address}`)
}

export function getRelayTask(taskId: string): RelayTask | null {
  return relayTasks.get(taskId) || null
}

export function updateRelayTask(taskId: string, update: Partial<RelayTask>): RelayTask | null {
  const task = relayTasks.get(taskId)
  if (!task) return null
  const updated = { ...task, ...update, updatedAt: Date.now() }
  relayTasks.set(taskId, updated)
  console.log(`[1Shot] Task updated: ${taskId} status=${updated.status} txHash=${updated.txHash || 'none'}`)
  return updated
}

setInterval(() => {
  const cutoff = Date.now() - 3600_000
  for (const [id, task] of relayTasks) {
    if (task.createdAt < cutoff) relayTasks.delete(id)
  }
}, 300_000)

// ─── 1Shot JSON-RPC ───

async function rpcCall(method: string, params: unknown): Promise<unknown> {
  console.log(`[1Shot] RPC call: ${method}`)
  const res = await fetch(RELAYER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  const data = await res.json()
  if (data.error) {
    console.error(`[1Shot] RPC error: ${method}`, data.error)
    throw new Error(`1Shot RPC error: ${JSON.stringify(data.error)}`)
  }
  console.log(`[1Shot] RPC success: ${method}`)
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

// relayer_sendTransaction — simple relay with optional EIP-7702 authorizationList
export async function relaySendBasicTransaction(params: {
  chainId: string
  to: string
  data: string
  context?: string
  authorizationList?: Record<string, unknown>[]
}): Promise<string> {
  const result = await rpcCall('relayer_sendTransaction', {
    chainId: params.chainId,
    payment: { type: 'token', address: USDC_BASE },
    to: params.to,
    data: params.data,
    context: params.context,
    authorizationList: params.authorizationList || [],
  })
  return result as string
}

// relayer_estimate7710Transaction — pre-validate bundle + get exact fee
export async function estimate7710Transaction(params: {
  chainId: string
  transactions: {
    permissionContext: unknown[]
    executions: { target: string; value: string; data: string }[]
  }[]
  authorizationList?: Record<string, unknown>[]
}): Promise<{
  success: boolean
  requiredPaymentAmount: string
  gasUsed: string
  context: string
}> {
  const result = await rpcCall('relayer_estimate7710Transaction', {
    chainId: params.chainId,
    transactions: params.transactions,
    authorizationList: params.authorizationList || [],
  })
  return result as any
}

// relayer_send7710Transaction — delegation bundle relay
export async function relaySend7710Transaction(params: {
  chainId: string
  transactions: {
    permissionContext: unknown[]
    executions: { target: string; value: string; data: string }[]
  }[]
  authorizationList?: Record<string, unknown>[]
  context?: string
  destinationUrl?: string
}): Promise<string> {
  const rpcParams: Record<string, unknown> = {
    chainId: params.chainId,
    transactions: params.transactions,
    authorizationList: params.authorizationList || [],
    context: params.context,
  }
  if (params.destinationUrl) {
    rpcParams.destinationUrl = params.destinationUrl
  }
  console.log(`[1Shot] send7710 payload:`, JSON.stringify({
    chainId: rpcParams.chainId,
    txCount: params.transactions.length,
    delegationCount: params.transactions[0]?.permissionContext?.length || 0,
    delegator: (params.transactions[0]?.permissionContext?.[0] as any)?.delegator,
    execCount: params.transactions[0]?.executions?.length || 0,
    execTarget: params.transactions[0]?.executions?.[0]?.target,
    hasContext: !!params.context,
  }))
  const result = await rpcCall('relayer_send7710Transaction', rpcParams)
  return result as string
}

// relayer_getStatus — single task status check
export async function getRelayStatusSingle(taskId: string): Promise<RelayStatus> {
  const result = await rpcCall('relayer_getStatus', {
    id: taskId,
    logs: false,
  })
  return result as RelayStatus
}

// Legacy wrapper for compatibility
export async function getRelayStatus(taskIds: string[]): Promise<{ taskId: string; status: string; txHash?: string; blockNumber?: number }[]> {
  const results = []
  for (const id of taskIds) {
    try {
      const r = await getRelayStatusSingle(id)
      const statusMap: Record<number, string> = {
        100: 'Pending',
        110: 'Submitted',
        200: 'Confirmed',
        400: 'Rejected',
        500: 'Reverted',
      }
      results.push({
        taskId: id,
        status: statusMap[r.status] || 'Pending',
        txHash: r.receipt?.transactionHash || r.hash,
        blockNumber: r.receipt?.blockNumber,
      })
    } catch (err: any) {
      console.warn(`[1Shot] Status check failed for ${id}:`, err?.message)
      results.push({ taskId: id, status: 'Pending' })
    }
  }
  return results
}

export async function relayDelegationRedemption(params: {
  delegationChain: Record<string, unknown>[]
  executionCalldata: `0x${string}`
  executionTarget?: string
  eip7702Auth?: Record<string, unknown>
}): Promise<{ taskId: string; feeContext: string }> {
  const fee = await getFeeData()

  const taskId = await relaySend7710Transaction({
    chainId: BASE_CHAIN_ID,
    transactions: [{
      permissionContext: params.delegationChain,
      executions: [{
        target: USDC_BASE,
        value: '0x0',
        data: params.executionCalldata,
      }],
    }],
    authorizationList: params.eip7702Auth ? [params.eip7702Auth] : [],
    context: fee.context,
  })

  return { taskId, feeContext: fee.context }
}

// ─── EIP-7702 relay: upgrade EOA to Smart Account via 1Shot ───

export interface EIP7702Authorization {
  chainId: number
  address: string
  nonce: number
  yParity: number
  r: string
  s: string
}

export async function relay7702Authorization(params: {
  authorization: EIP7702Authorization
  signerAddress: string
}): Promise<{ taskId: string; feeContext: string }> {
  console.log(`[1Shot] relay7702Authorization for ${params.signerAddress}`)
  console.log(`[1Shot] Implementation contract: ${params.authorization.address}`)

  const fee = await getFeeData()
  console.log(`[1Shot] Fee context obtained, expiry=${fee.expiry}`)

  const taskId = await relaySendBasicTransaction({
    chainId: BASE_CHAIN_ID,
    to: params.signerAddress,
    data: '0x',
    context: fee.context,
    authorizationList: [{
      chainId: `0x${params.authorization.chainId.toString(16)}`,
      address: params.authorization.address,
      nonce: `0x${params.authorization.nonce.toString(16)}`,
      yParity: `0x${params.authorization.yParity.toString(16)}`,
      r: params.authorization.r,
      s: params.authorization.s,
    }],
  })

  const task: RelayTask = {
    taskId,
    type: '7702',
    status: 'submitted',
    txHash: null,
    blockNumber: null,
    address: params.signerAddress,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  storeRelayTask(task)

  console.log(`[1Shot] 7702 relay submitted: taskId=${taskId}`)
  return { taskId, feeContext: fee.context }
}

// ─── Poll 1Shot for task status and update local store ───

export async function pollAndUpdateTask(taskId: string): Promise<RelayTask | null> {
  const task = getRelayTask(taskId)
  if (!task) return null
  if (task.status === 'confirmed' || task.status === 'failed') return task

  try {
    const status = await getRelayStatusSingle(taskId)

    if (status.status === 200) {
      return updateRelayTask(taskId, {
        status: 'confirmed',
        txHash: status.receipt?.transactionHash || null,
        blockNumber: status.receipt?.blockNumber || null,
      })
    } else if (status.status === 400 || status.status === 500) {
      return updateRelayTask(taskId, {
        status: 'failed',
        txHash: status.receipt?.transactionHash || null,
        error: status.message || `Relay status ${status.status}`,
      })
    }
  } catch (err: any) {
    console.error(`[1Shot] Poll error for ${taskId}:`, err?.message)
  }
  return task
}
