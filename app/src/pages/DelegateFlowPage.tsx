import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { type Address } from 'viem'
import { useSmartAccount, type SmartAccountStatus } from '../hooks/useSmartAccount'
import { useDelegation } from '../hooks/useDelegation'

const API = import.meta.env.PROD ? '' : 'http://localhost:3001'

interface FlowStep {
  type: string
  message?: string
  agents?: { slug: string; name: string; score: number }[]
  delegations?: { agentName: string; amount: string }[]
  agentName?: string
  taskId?: string
  report?: string
  imageUrl?: string | null
  totalSpent?: string
  delegationChain?: unknown[]
}

interface FlowResult {
  flowId: string
  status: string
  steps: FlowStep[]
  selectedAgents: { slug: string; name: string; description: string }[]
  report: string | null
  reportImageUrl: string | null
  totalSpent: string
}

type PageState = 'setup' | 'running' | 'complete' | 'error'

const STEP_ICONS: Record<string, string> = {
  analyzing: '🔍',
  matching: '🎯',
  delegating: '🔗',
  executing: '⚡',
  relaying: '📡',
  synthesizing: '🧪',
  complete: '✅',
  error: '❌',
}

export default function DelegateFlowPage() {
  const { authenticated, getAccessToken } = usePrivy()
  const { wallets } = useWallets()
  const { status: saStatus, upgradeToSmartAccount, smartAccount } = useSmartAccount()
  const { create: createClientDelegation, isCreating: isDelegating } = useDelegation()

  const [task, setTask] = useState('')
  const [budget, setBudget] = useState('2.00')
  const [pageState, setPageState] = useState<PageState>('setup')
  const [steps, setSteps] = useState<FlowStep[]>([])
  const [result, setResult] = useState<FlowResult | null>(null)
  const [error, setError] = useState('')
  const [delegationId, setDelegationId] = useState<string | null>(null)

  const wallet = wallets?.[0]
  const walletAddr = wallet?.address as Address | undefined

  const handleUpgrade = useCallback(async () => {
    if (!wallet) return
    const provider = await wallet.getEthereumProvider()
    await upgradeToSmartAccount(provider, walletAddr!)
  }, [wallet, walletAddr, upgradeToSmartAccount])

  const createDelegation = useCallback(async () => {
    if (!walletAddr) return null
    const res = await fetch(`${API}/api/delegateflow/delegation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        delegator: walletAddr,
        delegate: walletAddr,
        maxAmountUsdc: budget,
        expiresAt: Date.now() + 3600000,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to create delegation')
    return data.delegationId as string
  }, [walletAddr, budget])

  const startFlow = useCallback(async () => {
    if (!task.trim() || !walletAddr) return

    setPageState('running')
    setSteps([])
    setResult(null)
    setError('')

    try {
      const delId = await createDelegation()
      if (!delId) throw new Error('Failed to create delegation')
      setDelegationId(delId)

      const res = await fetch(`${API}/api/delegateflow/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, budget, delegationId: delId }),
      })

      const data: FlowResult = await res.json()
      if (!res.ok) throw new Error((data as any).error || 'Flow failed')

      setSteps(data.steps)
      setResult(data)
      setPageState(data.status === 'complete' ? 'complete' : 'error')
    } catch (err: any) {
      setError(err.message)
      setPageState('error')
    }
  }, [task, budget, walletAddr, createDelegation])

  const reset = () => {
    setPageState('setup')
    setSteps([])
    setResult(null)
    setError('')
    setTask('')
    setBudget('2.00')
    setDelegationId(null)
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">
            DelegateFlow
          </h1>
          <p className="text-gray-400 text-sm">
            Delegate USDC spending to AI agents via ERC-7710 • Powered by Venice AI + 1Shot Relay
          </p>
          <div className="flex gap-2 mt-3 flex-wrap">
            <span className="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">MetaMask Smart Accounts</span>
            <span className="text-xs px-2 py-1 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">ERC-7710 Delegation</span>
            <span className="text-xs px-2 py-1 rounded bg-green-500/20 text-green-300 border border-green-500/30">Venice AI</span>
            <span className="text-xs px-2 py-1 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30">1Shot Relay</span>
            <span className="text-xs px-2 py-1 rounded bg-pink-500/20 text-pink-300 border border-pink-500/30">x402 Payments</span>
          </div>
        </div>

        {/* Setup Phase */}
        {pageState === 'setup' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            {/* Wallet + Smart Account Status */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Wallet & Smart Account</h2>
              {walletAddr ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    <span className="font-mono text-sm">{walletAddr.slice(0, 6)}...{walletAddr.slice(-4)}</span>
                    <span className="text-xs text-gray-500">Connected via Privy</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${saStatus === 'smart-account' ? 'bg-purple-400 animate-pulse' : 'bg-gray-600'}`} />
                    <span className="text-sm text-gray-300">
                      {saStatus === 'smart-account' ? 'MetaMask Smart Account Active' :
                       saStatus === 'upgrading' ? 'Upgrading to Smart Account...' :
                       'EOA (not upgraded)'}
                    </span>
                    {saStatus !== 'smart-account' && saStatus !== 'upgrading' && (
                      <button
                        onClick={handleUpgrade}
                        className="text-xs px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 transition-colors"
                      >
                        Upgrade (EIP-7702)
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-gray-500 text-sm">Connect your wallet to continue</p>
              )}
            </div>

            {/* Task Input */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Research Task</h2>
              <textarea
                value={task}
                onChange={e => setTask(e.target.value)}
                placeholder="e.g. Research the top DeFi yield opportunities on Base"
                rows={3}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:border-blue-500 resize-none"
              />
            </div>

            {/* Budget */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Delegation Budget (USDC)</h2>
              <div className="flex items-center gap-4">
                <input
                  type="range"
                  min="0.50"
                  max="10.00"
                  step="0.50"
                  value={budget}
                  onChange={e => setBudget(e.target.value)}
                  className="flex-1 accent-blue-500"
                />
                <span className="font-mono text-xl font-bold text-blue-400">${budget}</span>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Max amount the orchestrator can spend via ERC-7710 delegation. Unspent funds remain yours.
              </p>
            </div>

            {/* Delegation Preview */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Delegation Preview</h2>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Token</span>
                  <span className="font-mono">USDC (Base)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Max Amount</span>
                  <span className="font-mono text-blue-400">${budget}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Expiry</span>
                  <span>1 hour</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Caveats</span>
                  <span>USDC only, amount-capped, time-limited</span>
                </div>
              </div>
            </div>

            {/* Start Button */}
            <button
              onClick={startFlow}
              disabled={!task.trim() || !walletAddr}
              className="w-full py-4 rounded-xl font-semibold text-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 transition-colors"
            >
              {!walletAddr ? 'Connect Wallet First' : !task.trim() ? 'Enter a Research Task' : `Delegate $${budget} & Start Flow`}
            </button>
          </motion.div>
        )}

        {/* Running Phase */}
        {pageState === 'running' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Flow Progress</h2>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-blue-400">Running DelegateFlow...</span>
              </div>
              <StepList steps={steps} />
            </div>
          </motion.div>
        )}

        {/* Complete Phase */}
        {pageState === 'complete' && result && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            {/* Summary */}
            <div className="bg-gray-900 border border-green-800/50 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-green-400 text-xl">✅</span>
                <h2 className="text-lg font-bold text-green-400">Flow Complete</h2>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-400">${result.totalSpent}</div>
                  <div className="text-xs text-gray-400">Total Spent</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-purple-400">{result.selectedAgents.length}</div>
                  <div className="text-xs text-gray-400">Agents Used</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-400">{result.steps.length}</div>
                  <div className="text-xs text-gray-400">Steps</div>
                </div>
              </div>
            </div>

            {/* Selected Agents */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Selected Agents</h2>
              <div className="space-y-2">
                {result.selectedAgents.map(a => (
                  <div key={a.slug} className="flex items-center gap-3 bg-gray-800 rounded-lg px-4 py-3">
                    <div className="w-8 h-8 rounded-full bg-purple-500/30 flex items-center justify-center text-sm">🤖</div>
                    <div>
                      <div className="font-semibold text-sm">{a.name}</div>
                      <div className="text-xs text-gray-400">{a.description.slice(0, 80)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Delegation Chain */}
            <DelegationChainViz
              delegationId={delegationId}
              agents={result.selectedAgents}
              budget={budget}
              totalSpent={result.totalSpent}
            />

            {/* Steps */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Execution Steps</h2>
              <StepList steps={result.steps} />
            </div>

            {/* Report */}
            {result.report && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Venice AI Report</h2>
                {result.reportImageUrl && (
                  <img src={result.reportImageUrl} alt="AI Generated Summary" className="w-full rounded-lg mb-4 border border-gray-700" />
                )}
                <div className="prose prose-invert prose-sm max-w-none text-gray-300 whitespace-pre-wrap">
                  {result.report}
                </div>
              </div>
            )}

            {/* Reset */}
            <button onClick={reset} className="w-full py-3 rounded-xl font-semibold bg-gray-800 hover:bg-gray-700 transition-colors">
              New Flow
            </button>
          </motion.div>
        )}

        {/* Error Phase */}
        {pageState === 'error' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <div className="bg-gray-900 border border-red-800/50 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-red-400 text-xl">❌</span>
                <h2 className="text-lg font-bold text-red-400">Flow Failed</h2>
              </div>
              <p className="text-gray-400 text-sm">{error}</p>
            </div>
            {steps.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Steps Before Failure</h2>
                <StepList steps={steps} />
              </div>
            )}
            <button onClick={reset} className="w-full py-3 rounded-xl font-semibold bg-gray-800 hover:bg-gray-700 transition-colors">
              Try Again
            </button>
          </motion.div>
        )}

        {/* Architecture Footer */}
        <div className="mt-12 border-t border-gray-800 pt-8">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">Architecture</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: 'MetaMask Smart Accounts', desc: 'EIP-7702 upgrade' },
              { label: 'ERC-7710', desc: 'Scoped delegation + redelegation' },
              { label: 'Venice AI', desc: 'Chat, Embeddings, Image, Crypto RPC' },
              { label: '1Shot Relay', desc: 'Gasless tx relay (USDC gas)' },
              { label: 'x402 Protocol', desc: 'HTTP 402 micropayments' },
            ].map(t => (
              <div key={t.label} className="bg-gray-900/50 border border-gray-800 rounded-lg p-3 text-center">
                <div className="text-xs font-semibold text-white">{t.label}</div>
                <div className="text-[10px] text-gray-500 mt-1">{t.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function StepList({ steps }: { steps: FlowStep[] }) {
  return (
    <div className="space-y-2">
      <AnimatePresence>
        {steps.map((step, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
            className="flex items-start gap-3 text-sm"
          >
            <span className="text-base mt-0.5">{STEP_ICONS[step.type] || '⏳'}</span>
            <div className="flex-1">
              <span className="text-gray-300">{step.message || step.type}</span>
              {step.agents && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {step.agents.map(a => (
                    <span key={a.slug} className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">
                      {a.name} ({(a.score * 100).toFixed(0)}%)
                    </span>
                  ))}
                </div>
              )}
              {step.delegations && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {step.delegations.map((d, j) => (
                    <span key={j} className="text-xs bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded">
                      {d.agentName}: ${d.amount}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

function DelegationChainViz({ delegationId, agents, budget, totalSpent }: {
  delegationId: string | null
  agents: { slug: string; name: string }[]
  budget: string
  totalSpent: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Delegation Chain (ERC-7710)</h2>
      <div className="flex flex-col items-center gap-2">
        {/* Root */}
        <div className="bg-blue-500/20 border border-blue-500/40 rounded-lg px-4 py-2 text-center">
          <div className="text-xs text-blue-400">User (Delegator)</div>
          <div className="text-sm font-mono font-bold">${budget} USDC</div>
        </div>
        <div className="w-px h-6 bg-gray-600" />
        <div className="text-xs text-gray-500">ERC-7710 Delegation</div>
        <div className="w-px h-6 bg-gray-600" />

        {/* Orchestrator */}
        <div className="bg-purple-500/20 border border-purple-500/40 rounded-lg px-4 py-2 text-center">
          <div className="text-xs text-purple-400">Orchestrator Agent</div>
          <div className="text-sm font-mono">${budget} budget</div>
        </div>

        {/* Redelegation arrows */}
        {agents.length > 0 && (
          <>
            <div className="w-px h-4 bg-gray-600" />
            <div className="text-xs text-gray-500">Redelegation</div>
            <div className="flex gap-4 mt-2">
              {agents.map(a => (
                <div key={a.slug} className="bg-green-500/20 border border-green-500/40 rounded-lg px-3 py-2 text-center min-w-[120px]">
                  <div className="text-xs text-green-400">Sub-Agent</div>
                  <div className="text-sm font-semibold">{a.name}</div>
                  <div className="text-xs font-mono text-gray-400">
                    ${(parseFloat(budget) / agents.length).toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Totals */}
        <div className="mt-4 text-center">
          <span className="text-xs text-gray-500">Total spent: </span>
          <span className="text-sm font-mono text-green-400">${totalSpent}</span>
          <span className="text-xs text-gray-500"> of ${budget}</span>
        </div>
      </div>
    </div>
  )
}
