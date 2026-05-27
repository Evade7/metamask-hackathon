import { useState, useCallback } from 'react'
import { parseUnits, type Address, type Hex } from 'viem'
import {
  createDelegation,
  getDeleGatorEnvironment,
  type Delegation,
} from '@metamask/delegation-toolkit'

const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_CHAIN_ID = 8453

export interface DelegationParams {
  delegator: Address
  delegate: Address
  amountUsdc: string
  expiresInMs?: number
}

export interface DelegationResult {
  delegation: Delegation
  unsigned: true
}

export function useDelegation() {
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [delegation, setDelegation] = useState<Delegation | null>(null)

  const environment = getDeleGatorEnvironment(BASE_CHAIN_ID)

  const create = useCallback(async (params: DelegationParams): Promise<DelegationResult | null> => {
    setIsCreating(true)
    setError(null)

    try {
      const d = createDelegation({
        environment,
        from: params.delegator as Hex,
        to: params.delegate as Hex,
        scope: {
          type: 'erc20TransferAmount',
          tokenAddress: USDC_BASE,
          maxAmount: parseUnits(params.amountUsdc, 6),
        },
      })

      setDelegation(d)
      return { delegation: d, unsigned: true }
    } catch (err: any) {
      setError(err.message)
      return null
    } finally {
      setIsCreating(false)
    }
  }, [environment])

  const createRedelegation = useCallback(async (
    parentDelegation: Delegation,
    delegate: Address,
    amountUsdc: string,
  ): Promise<DelegationResult | null> => {
    setIsCreating(true)
    setError(null)

    try {
      const d = createDelegation({
        environment,
        from: parentDelegation.delegate as Hex,
        to: delegate as Hex,
        parentDelegation,
        scope: {
          type: 'erc20TransferAmount',
          tokenAddress: USDC_BASE,
          maxAmount: parseUnits(amountUsdc, 6),
        },
      })

      return { delegation: d, unsigned: true }
    } catch (err: any) {
      setError(err.message)
      return null
    } finally {
      setIsCreating(false)
    }
  }, [environment])

  return {
    create,
    createRedelegation,
    delegation,
    isCreating,
    error,
    environment,
  }
}
