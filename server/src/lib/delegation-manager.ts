import { parseUnits, type Address } from 'viem'

const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

export interface DelegationRecord {
  id: string
  delegator: Address
  delegate: Address
  parentId: string | null
  tokenAddress: Address
  maxAmount: bigint
  amountRedeemed: bigint
  expiresAt: number
  status: 'active' | 'redeemed' | 'expired' | 'revoked'
  signedDelegation: unknown
  redeemTxHash: string | null
  relayTaskId: string | null
  createdAt: number
}

const delegations = new Map<string, DelegationRecord>()

export function storeDelegation(record: DelegationRecord): void {
  delegations.set(record.id, record)
  console.log(`[Delegation] Stored: ${record.id} (${record.delegator} -> ${record.delegate}, $${formatUsdc(record.maxAmount)} USDC)`)
}

export function getDelegation(id: string): DelegationRecord | undefined {
  return delegations.get(id)
}

export function getDelegationChain(id: string): DelegationRecord[] {
  const chain: DelegationRecord[] = []
  let current = delegations.get(id)
  while (current) {
    chain.unshift(current)
    current = current.parentId ? delegations.get(current.parentId) : undefined
  }
  return chain
}

export function getChildDelegations(parentId: string): DelegationRecord[] {
  const children: DelegationRecord[] = []
  for (const d of delegations.values()) {
    if (d.parentId === parentId) children.push(d)
  }
  return children
}

export function createRedelegation(params: {
  parentId: string
  delegate: Address
  maxAmount: bigint
  expiresAt?: number
}): DelegationRecord {
  const parent = delegations.get(params.parentId)
  if (!parent) throw new Error('Parent delegation not found')
  if (parent.status !== 'active') throw new Error('Parent delegation not active')

  const childrenTotal = getChildDelegations(params.parentId)
    .filter(c => c.status === 'active')
    .reduce((sum, c) => sum + c.maxAmount, 0n)

  if (childrenTotal + params.maxAmount > parent.maxAmount) {
    throw new Error('Redelegation exceeds parent budget')
  }

  const record: DelegationRecord = {
    id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    delegator: parent.delegate,
    delegate: params.delegate,
    parentId: params.parentId,
    tokenAddress: USDC_BASE,
    maxAmount: params.maxAmount,
    amountRedeemed: 0n,
    expiresAt: params.expiresAt || parent.expiresAt,
    status: 'active',
    signedDelegation: null,
    redeemTxHash: null,
    relayTaskId: null,
    createdAt: Date.now(),
  }

  storeDelegation(record)
  return record
}

export function markRedeemed(id: string, txHash: string, amount: bigint): void {
  const d = delegations.get(id)
  if (!d) return
  d.amountRedeemed += amount
  d.redeemTxHash = txHash
  if (d.amountRedeemed >= d.maxAmount) d.status = 'redeemed'
}

export function revokeDelegation(id: string): void {
  const d = delegations.get(id)
  if (!d) return
  d.status = 'revoked'
  for (const child of getChildDelegations(id)) {
    child.status = 'revoked'
  }
}

export function getAllDelegations(): DelegationRecord[] {
  return Array.from(delegations.values())
}

export function buildDelegationScope(amountUsdc: string) {
  return {
    type: 'erc20TransferAmount' as const,
    tokenAddress: USDC_BASE,
    maxAmount: parseUnits(amountUsdc, 6),
  }
}

function formatUsdc(amount: bigint): string {
  return (Number(amount) / 1e6).toFixed(2)
}
