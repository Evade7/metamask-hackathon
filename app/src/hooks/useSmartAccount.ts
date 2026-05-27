import { useState, useCallback } from 'react'
import { createPublicClient, createWalletClient, custom, http, type Address, type Hex } from 'viem'
import { base } from 'viem/chains'
import {
  toMetaMaskSmartAccount,
  Implementation,
  getDeleGatorEnvironment,
} from '@metamask/delegation-toolkit'
import type { SmartAccount } from 'viem/account-abstraction'

const BASE_CHAIN_ID = 8453

export type SmartAccountStatus = 'disconnected' | 'eoa' | 'upgrading' | 'smart-account' | 'error'

export function useSmartAccount() {
  const [status, setStatus] = useState<SmartAccountStatus>('disconnected')
  const [smartAccount, setSmartAccount] = useState<SmartAccount | null>(null)
  const [error, setError] = useState<string | null>(null)

  const environment = getDeleGatorEnvironment(BASE_CHAIN_ID)

  const upgradeToSmartAccount = useCallback(async (walletProvider: any, address: Address) => {
    setStatus('upgrading')
    setError(null)

    try {
      const publicClient = createPublicClient({
        chain: base,
        transport: http(),
      })

      const walletClient = createWalletClient({
        chain: base,
        transport: custom(walletProvider),
        account: address,
      })

      const account = await toMetaMaskSmartAccount({
        client: publicClient,
        implementation: Implementation.Hybrid,
        signer: {
          type: 'wallet',
          data: { walletClient },
        },
        address,
        environment,
      })

      setSmartAccount(account as SmartAccount)
      setStatus('smart-account')
      return account
    } catch (err: any) {
      setError(err.message)
      setStatus('error')
      return null
    }
  }, [environment])

  const signDelegation = useCallback(async (delegation: any) => {
    if (!smartAccount) throw new Error('Smart account not initialized')

    const impl = (smartAccount as any).nonceKeyManager ? smartAccount : smartAccount
    if (typeof (impl as any).signDelegation === 'function') {
      return (impl as any).signDelegation({ delegation })
    }
    throw new Error('Smart account does not support delegation signing')
  }, [smartAccount])

  return {
    status,
    smartAccount,
    error,
    environment,
    upgradeToSmartAccount,
    signDelegation,
  }
}
