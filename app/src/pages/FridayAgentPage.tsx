import { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useWallets } from '@privy-io/react-auth'
import { type Address } from 'viem'
import { useSmartAccount } from '../hooks/useSmartAccount'
import { useDelegation } from '../hooks/useDelegation'
import { ProofTimeline } from '../components/ProofTimeline'
import { HackathonVerification } from '../components/HackathonVerification'
import { getUsdcBalance } from '../lib/splitter'

const API = import.meta.env.PROD ? '' : 'http://localhost:3001'
const ORCHESTRATOR_ADDRESS = (import.meta.env.VITE_ORCHESTRATOR_ADDRESS || '0xA702Fb74B88A5199F9011eca0c9Bee38984A9Abb') as Address

interface FlowStep {
  type: string
  message?: string
  agents?: { slug: string; name: string; score: number }[]
  allocations?: { agentName: string; amount: string; reasoning: string }[]
  delegations?: { agentName: string; amount: string }[]
  agentName?: string
  taskId?: string
  amount?: string
  txHash?: string
  replyLength?: number
  reason?: string
  report?: string
  imageUrl?: string | null
  totalSpent?: string
  planningReasoning?: string
  skillLearned?: string
  checks?: {
    http402Received: boolean
    paymentSignatureSent: boolean
    priorPaymentVerified: boolean
    responseUnlocked: boolean
    priorPaymentTxHash: string | null
  }
}

interface FlowResult {
  flowId: string
  sessionId?: string
  status: string
  steps: FlowStep[]
  selectedAgents: { slug: string; name: string; description: string }[]
  report: string | null
  reportImageUrl: string | null
  totalSpent: string
  budget?: string
  relayFees?: string
  balanceRemaining?: string
  relayResults?: { agentName: string; taskId: string; txHash: string | null }[]
  x402Results?: { agentName: string; http402Received: boolean; paymentSignatureSent: boolean; priorPaymentVerified: boolean; responseUnlocked: boolean; priorPaymentTxHash: string | null }[]
  agentCalls?: { agentName: string; callCount: number; subtask: string }[]
  planningReasoning?: string
  skillLearned?: string
}

type PageState = 'setup' | 'running' | 'complete' | 'error'

const QUICK_TASKS = [
  { label: 'DeFi Research', task: 'Research the top DeFi yield opportunities on Base for a $10K portfolio' },
  { label: 'Market Analysis', task: 'Analyze the latest crypto market trends and top momentum plays' },
  { label: 'Contract Audit', task: 'Audit a smart contract for common vulnerabilities and security issues' },
  { label: 'Trend Report', task: 'Find the best memecoin launches on Base this week with social analysis' },
]

const POWERED_BY = [
  { name: 'Venice AI', color: 'bg-cyan/10 border-cyan/20 text-cyan' },
  { name: 'MetaMask', color: 'bg-orange/10 border-orange/20 text-orange' },
  { name: '1Shot', color: 'bg-green/10 border-green/20 text-green' },
  { name: 'x402', color: 'bg-pink/10 border-pink/20 text-pink' },
]

export default function FridayAgentPage() {
  const { wallets } = useWallets()
  const { status: saStatus, error: saError, upgradeToSmartAccount, permissionGrant, upgradeProof } = useSmartAccount()

  const [task, setTask] = useState('')
  const [budget, setBudget] = useState('5.00')
  const [pageState, setPageState] = useState<PageState>('setup')
  const [steps, setSteps] = useState<FlowStep[]>([])
  const [result, setResult] = useState<FlowResult | null>(null)
  const [error, setError] = useState('')
  const [delegationId, setDelegationId] = useState<string | null>(null)
  const [onChainTxs, setOnChainTxs] = useState<{ label: string; amount: string; txHash: string | null; status: string }[]>([])
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null)
  const [activity, setActivity] = useState<{
    jobs: { sessionId: string; task: string; status: string; spent: string; agentCount: number; agents: string[]; txCount: number; txHashes: string[]; createdAt: string; completedAt: string | null }[]
    stats: { totalJobs: number; completedJobs: number; successRate: string; totalSpent: string; totalAgentsHired: number; totalOnChainTx: number; avgCompletionSeconds: number }
    topAgents: { slug: string; timesHired: number }[]
  } | null>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const executionRef = useRef<HTMLDivElement>(null)

  const wallet = wallets?.[0]
  const walletAddr = wallet?.address as Address | undefined

  useEffect(() => {
    if (!walletAddr) { setUsdcBalance(null); return }
    getUsdcBalance(walletAddr).then(raw => {
      const bal = Number(raw) / 1e6
      setUsdcBalance(bal)
      setBudget(prev => {
        const current = parseFloat(prev)
        return current > bal ? Math.max(0.5, Math.floor(bal * 2) / 2).toFixed(2) : prev
      })
    }).catch(() => {})
  }, [walletAddr])

  useEffect(() => {
    if (executionRef.current && pageState === 'running') {
      executionRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [steps.length, pageState])

  // Fetch Friday activity from real proof_events
  useEffect(() => {
    fetch(`${API}/api/proofs/friday/activity`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setActivity(data) })
      .catch(() => {})
  }, [result])

  // Extract on-chain transactions from steps
  useEffect(() => {
    const txs: typeof onChainTxs = []
    for (const step of steps) {
      if (step.type === 'relaying' && step.agentName) {
        txs.push({ label: `Paid: ${step.agentName}`, amount: '', txHash: null, status: 'confirming' })
      }
    }
    if (result?.relayResults) {
      const updated = result.relayResults.map(r => ({
        label: `Paid: ${r.agentName}`,
        amount: '',
        txHash: r.txHash,
        status: r.txHash ? 'confirmed' : 'pending',
      }))
      setOnChainTxs(updated)
      return
    }
    setOnChainTxs(txs)
  }, [steps, result])

  const handleUpgrade = useCallback(async () => {
    if (!wallet) return
    const provider = await wallet.getEthereumProvider()
    await upgradeToSmartAccount(provider, walletAddr!, budget)
  }, [wallet, walletAddr, upgradeToSmartAccount, budget])

  const startFlow = useCallback(async () => {
    if (!task.trim() || !walletAddr || saStatus !== 'smart-account') return

    setPageState('running')
    setSteps([])
    setResult(null)
    setError('')
    setOnChainTxs([])

    try {
      const res = await fetch(`${API}/api/delegateflow/delegation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          delegator: walletAddr,
          delegate: ORCHESTRATOR_ADDRESS,
          maxAmountUsdc: budget,
          expiresAt: Date.now() + 3600000,
          signedDelegation: permissionGrant ? {
            permissionContext: permissionGrant.context,
            delegations: permissionGrant.delegations,
          } : null,
        }),
      })
      const delData = await res.json()
      if (!res.ok) throw new Error(delData.error || 'Failed to register delegation')
      setDelegationId(delData.delegationId)

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 120000)

      const flowRes = await fetch(`${API}/api/delegateflow/start/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, budget, delegationId: delData.delegationId }),
        signal: controller.signal,
      })

      if (!flowRes.ok) {
        clearTimeout(timeout)
        const errData = await flowRes.json().catch(() => ({}))
        throw new Error(errData.error || 'Flow failed')
      }

      const reader = flowRes.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let localSteps: FlowStep[] = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const events = buffer.split('\n\n')
        buffer = events.pop()!

        for (const event of events) {
          if (!event.startsWith('data: ')) continue
          if (event.slice(6).trim() === '') continue
          try {
            const data = JSON.parse(event.slice(6))
            if (data.type === 'step') {
              localSteps.push(data.step)
              setSteps(prev => [...prev, data.step])
            } else if (data.type === 'complete') {
              setResult(data.result)
              setPageState(data.result.status === 'complete' ? 'complete' : 'error')
            } else if (data.type === 'error') {
              throw new Error(data.error)
            }
          } catch (e: any) {
            if (e.message && !e.message.includes('JSON')) throw e
          }
        }
      }
      clearTimeout(timeout)
    } catch (err: any) {
      const stepsSnapshot = steps.length > 0 ? steps : []
      const relaySuccesses = stepsSnapshot.filter(s => s.type === 'relaying' || (s.type === 'delegating'))
      const x402Successes = stepsSnapshot.filter(s => s.type === 'x402-payment' && s.message?.includes('verified'))
      const txHashes = stepsSnapshot.filter(s => (s as any).checks?.priorPaymentTxHash).map(s => (s as any).checks.priorPaymentTxHash as string)

      let errorMsg = err.name === 'AbortError'
        ? 'Connection timed out after 2 minutes.'
        : (err.message || 'Something went wrong')

      if (stepsSnapshot.length > 0 && x402Successes.length > 0) {
        errorMsg = `Flow partially completed — ${x402Successes.length} agent(s) paid successfully. ${errorMsg}`
      }

      if (txHashes.length > 0) {
        errorMsg += ` | Confirmed txs: ${txHashes.map(h => h.slice(0, 10) + '...').join(', ')}`
      }

      setError(errorMsg)
      setPageState('error')
    }
  }, [task, budget, walletAddr, saStatus, permissionGrant])

  const reset = () => {
    setPageState('setup')
    setSteps([])
    setResult(null)
    setError('')
    setTask('')
    setBudget('2.00')
    setDelegationId(null)
    setOnChainTxs([])
  }

  const budgetSpent = result ? parseFloat(result.totalSpent) : steps.filter(s => s.type === 'relaying').length * (parseFloat(budget) / 3)
  const budgetPercent = Math.min((budgetSpent / parseFloat(budget)) * 100, 100)

  return (
    <div ref={pageRef} className="min-h-screen bg-bg text-t1 relative overflow-hidden">
      {/* Background */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-purple/[0.06] blur-[150px]" />
      <div className="absolute bottom-1/3 right-1/4 w-[400px] h-[400px] rounded-full bg-cyan/[0.04] blur-[100px]" />

      <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">

        {/* ===== HERO ===== */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-purple to-pink flex items-center justify-center text-3xl shadow-lg shadow-purple/20">
            F
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-2">
            <span className="text-gradient">Friday</span>
          </h1>
          <p className="text-t2 text-base mb-4">Your AI Hiring Manager</p>

          {/* ERC-8004 Identity */}
          <div className="mb-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-purple/5 border border-purple/20">
            <span className="text-purple text-sm font-bold">ERC-8004</span>
            <span className="text-t2 text-xs">Agent #54184</span>
            <span className="text-[10px] text-t3">|</span>
            <a href="https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=54184" target="_blank" rel="noopener noreferrer" className="text-xs text-purple hover:underline">BaseScan</a>
            <span className="text-[10px] text-t3">|</span>
            <span className="text-xs text-t3 font-mono">0xA702...9Abb</span>
          </div>

          <div className="flex flex-wrap justify-center gap-2">
            {POWERED_BY.map(p => (
              <span key={p.name} className={`text-xs px-2.5 py-1 rounded-full border ${p.color}`}>{p.name}</span>
            ))}
          </div>
        </motion.div>

        {/* ===== SETUP ===== */}
        {pageState === 'setup' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="space-y-5">

            {/* Task Input */}
            <div className="bg-surface border border-line rounded-2xl p-5">
              <label className="text-sm font-medium text-t2 mb-3 block">What do you need done?</label>
              <textarea
                value={task}
                onChange={e => setTask(e.target.value)}
                placeholder="Describe your task... Friday will hire the right AI agents for the job."
                rows={3}
                className="w-full bg-surface-2 border border-line rounded-xl px-4 py-3 text-t1 placeholder:text-t3 focus:outline-none focus:border-purple/40 resize-none"
              />
              <div className="flex flex-wrap gap-2 mt-3">
                {QUICK_TASKS.map(t => (
                  <button key={t.label} onClick={() => setTask(t.task)}
                    className="text-xs px-3 py-1.5 rounded-full bg-surface-2 border border-line text-t2 hover:border-purple/30 hover:text-t1 transition-all">
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Budget */}
            <div className="bg-surface border border-line rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <label className="text-sm font-medium text-t2">Budget</label>
                  {usdcBalance !== null && (
                    <span className="text-xs text-t3 ml-2">Balance: ${usdcBalance.toFixed(2)} USDC</span>
                  )}
                </div>
                <span className="text-2xl font-bold text-gradient">${budget}</span>
              </div>
              {usdcBalance !== null && usdcBalance < 0.5 ? (
                <div className="bg-red/10 border border-red/20 rounded-xl px-4 py-3 text-center">
                  <p className="text-sm text-red">No USDC in wallet — fund your wallet to use Friday</p>
                </div>
              ) : (
                <>
                  <input
                    type="range" min="0.50"
                    max={usdcBalance !== null ? Math.max(0.5, Math.floor(usdcBalance * 2) / 2).toFixed(2) : '100.00'}
                    step="0.50"
                    value={budget} onChange={e => setBudget(e.target.value)}
                    disabled={saStatus === 'smart-account'}
                    className={`w-full accent-purple h-2 ${saStatus === 'smart-account' ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />
                  <div className="flex justify-between text-xs text-t3 mt-1">
                    <span>$0.50</span>
                    <span>${usdcBalance !== null ? Math.max(0.5, Math.floor(usdcBalance * 2) / 2).toFixed(2) : '100.00'}</span>
                  </div>
                  <p className="text-xs text-t3 mt-2">
                    {saStatus === 'smart-account'
                      ? 'Budget locked — permission already signed for this amount.'
                      : 'Friday can only spend within this limit. Unspent funds stay in your wallet.'}
                  </p>
                </>
              )}
            </div>

            {/* MetaMask Connection */}
            {!walletAddr ? (
              <div className="bg-surface border border-orange/20 rounded-2xl p-5 text-center">
                <p className="text-sm text-t2 mb-2">Connect your MetaMask wallet to hire Friday</p>
                <p className="text-xs text-t3">MetaMask Smart Account required for scoped budget delegation</p>
              </div>
            ) : saStatus !== 'smart-account' ? (
              <div className="bg-surface border border-line rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-2 h-2 rounded-full bg-green animate-pulse" />
                  <span className="text-sm text-t2 font-mono">{walletAddr.slice(0, 6)}...{walletAddr.slice(-4)}</span>
                </div>

                {saStatus === 'requesting-permission' ? (
                  <div className="flex items-center gap-3 py-3">
                    <div className="w-4 h-4 border-2 border-purple border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm text-purple">Approving in MetaMask...</span>
                  </div>
                ) : saStatus === 'error' ? (
                  <div className="space-y-2">
                    <p className="text-sm text-red">{saError}</p>
                    <button onClick={handleUpgrade} className="text-xs px-3 py-1.5 rounded-lg bg-purple/10 border border-purple/20 text-purple">Retry</button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <button onClick={handleUpgrade}
                      className="w-full py-3 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-orange to-pink hover:opacity-90 transition-all">
                      Activate Smart Account (${budget} USDC limit)
                    </button>
                    <p className="text-xs text-t3 text-center">One MetaMask popup. No gas fees. 24h session.</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-surface border border-green/20 rounded-2xl p-4 flex items-center gap-3">
                <div className="w-2.5 h-2.5 rounded-full bg-green animate-pulse" />
                <span className="text-sm text-t1">Smart Account Active</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-green/10 border border-green/20 text-green ml-auto">
                  ${budget} approved
                </span>
              </div>
            )}

            {/* CTA */}
            <button onClick={startFlow}
              disabled={!task.trim() || !walletAddr || saStatus !== 'smart-account'}
              className="w-full py-4 rounded-2xl font-semibold text-base text-white bg-gradient-to-r from-purple to-pink hover:opacity-90 disabled:from-line disabled:to-line disabled:text-t3 transition-all shadow-lg shadow-purple/20 disabled:shadow-none">
              {!walletAddr ? 'Connect MetaMask to Start' :
               saStatus !== 'smart-account' ? 'Activate Smart Account First' :
               !task.trim() ? 'Describe your task above' :
               `Hire Friday — $${budget} USDC`}
            </button>
          </motion.div>
        )}

        {/* ===== RUNNING ===== */}
        {(pageState === 'running' || pageState === 'complete' || pageState === 'error') && (
          <div ref={executionRef} className="space-y-5">

            {/* Phase Progress */}
            {pageState === 'running' && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="bg-surface border border-line rounded-2xl p-4">
                <div className="flex items-center gap-3 flex-wrap">
                  {[
                    { key: 'plan', label: 'Analyzing', types: ['analyzing','matching','budgeting'] },
                    { key: 'pay', label: 'Paying', types: ['relay-submitting','relay-waiting','relay-confirmed','relay-failed'] },
                    { key: 'verify', label: 'Verifying', types: ['x402-verifying','x402-payment'] },
                    { key: 'work', label: 'Working', types: ['agent-working','agent-completed','agent-failed'] },
                    { key: 'synth', label: 'Synthesizing', types: ['synthesizing'] },
                  ].map(phase => {
                    const hasAny = steps.some(s => phase.types.includes(s.type))
                    const isLatest = phase.types.includes(steps[steps.length - 1]?.type)
                    return (
                      <div key={phase.key} className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full ${isLatest ? 'bg-purple animate-pulse' : hasAny ? 'bg-green' : 'bg-line'}`} />
                        <span className={`text-xs ${isLatest ? 'text-purple font-semibold' : hasAny ? 'text-t1' : 'text-t3'}`}>{phase.label}</span>
                        {phase.key !== 'synth' && <span className="text-t3 text-xs mx-1">{'>'}</span>}
                      </div>
                    )
                  })}
                </div>
              </motion.div>
            )}

            {/* Friday's Plan */}
            {steps.some(s => s.type === 'matching' || s.type === 'budgeting') && (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                className="bg-surface border border-purple/20 rounded-2xl p-5">
                <h2 className="text-sm font-semibold text-purple mb-3">Friday's Plan</h2>

                {/* Planning reasoning */}
                {steps.find(s => s.type === 'analyzing')?.message && (
                  <p className="text-sm text-t2 mb-4 italic">"{steps.find(s => s.type === 'analyzing')?.message}"</p>
                )}

                {/* Agent allocations */}
                {steps.find(s => s.allocations)?.allocations && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                    {steps.find(s => s.allocations)!.allocations!.map(a => (
                      <div key={a.agentName} className="bg-surface-2 border border-line rounded-xl p-3 text-center">
                        <div className="text-2xl mb-1">{'🤖'}</div>
                        <div className="text-xs font-semibold text-t1 truncate">{a.agentName}</div>
                        <div className="text-sm font-bold text-gradient mt-1">${a.amount}</div>
                        <div className="text-[10px] text-t3 mt-0.5 line-clamp-1">{a.reasoning}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Budget bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-t3">
                    <span>Budget</span>
                    <span>${budgetSpent.toFixed(2)} / ${budget}</span>
                  </div>
                  <div className="w-full h-2 bg-surface-2 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-gradient-to-r from-purple to-pink rounded-full"
                      animate={{ width: `${budgetPercent}%` }}
                      transition={{ duration: 0.5 }}
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {/* Hiring Progress — per-agent real-time status */}
            {steps.some(s => ['relay-submitting','relay-waiting','relay-confirmed','relay-failed','x402-verifying','x402-payment','agent-working','agent-completed','agent-failed','executing'].includes(s.type)) && (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                className="bg-surface border border-line rounded-2xl p-5">
                <h2 className="text-sm font-semibold text-t2 mb-4">
                  {pageState === 'running' ? 'Hiring in Progress...' : 'Agents Hired'}
                </h2>
                <div className="space-y-3">
                  {(() => {
                    const agentNames = [...new Set(steps.filter(s => s.agentName).map(s => s.agentName!))]
                    return agentNames.map(name => {
                      const agentSteps = steps.filter(s => s.agentName === name)
                      const latestStep = agentSteps[agentSteps.length - 1]
                      const relayConfirmed = agentSteps.find(s => s.type === 'relay-confirmed')
                      const relayFailed = agentSteps.find(s => s.type === 'relay-failed')
                      const x402Ok = agentSteps.find(s => s.type === 'x402-payment' && s.checks?.responseUnlocked)
                      const x402Fail = agentSteps.find(s => s.type === 'x402-payment' && !s.checks?.responseUnlocked)
                      const completed = agentSteps.find(s => s.type === 'agent-completed')
                      const failed = agentSteps.find(s => s.type === 'agent-failed')
                      const amount = agentSteps.find(s => s.amount)?.amount
                      const txHash = relayConfirmed?.txHash || agentSteps.find(s => s.checks?.priorPaymentTxHash)?.checks?.priorPaymentTxHash

                      let statusLabel = 'Queued'
                      let statusColor = 'bg-t3/10 border-t3/20 text-t3'
                      if (completed) { statusLabel = 'Completed'; statusColor = 'bg-green/10 border-green/20 text-green' }
                      else if (failed) { statusLabel = 'Failed'; statusColor = 'bg-red/10 border-red/20 text-red' }
                      else if (latestStep?.type === 'agent-working') { statusLabel = 'Working...'; statusColor = 'bg-purple/10 border-purple/20 text-purple' }
                      else if (x402Ok) { statusLabel = 'x402 Verified'; statusColor = 'bg-green/10 border-green/20 text-green' }
                      else if (x402Fail) { statusLabel = 'x402 Failed'; statusColor = 'bg-red/10 border-red/20 text-red' }
                      else if (latestStep?.type === 'x402-verifying') { statusLabel = 'Verifying x402...'; statusColor = 'bg-cyan/10 border-cyan/20 text-cyan' }
                      else if (relayConfirmed) { statusLabel = 'Tx Confirmed'; statusColor = 'bg-green/10 border-green/20 text-green' }
                      else if (relayFailed) { statusLabel = 'Tx Failed'; statusColor = 'bg-red/10 border-red/20 text-red' }
                      else if (latestStep?.type === 'relay-waiting') { statusLabel = 'Confirming...'; statusColor = 'bg-amber-400/10 border-amber-400/20 text-amber-400' }
                      else if (latestStep?.type === 'relay-submitting') { statusLabel = 'Submitting Tx'; statusColor = 'bg-amber-400/10 border-amber-400/20 text-amber-400' }

                      return (
                        <div key={name} className="bg-surface-2 border border-line rounded-xl p-3">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-purple/20 to-pink/20 border border-purple/20 flex items-center justify-center text-sm flex-shrink-0 font-bold text-purple">
                              {name.charAt(0)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-semibold text-t1 truncate">{name}</span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap ${statusColor}`}>
                                  {statusLabel}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 mt-0.5">
                                {amount && <span className="text-xs text-t3">${amount} USDC</span>}
                                {txHash && (
                                  <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
                                    className="text-[10px] font-mono text-cyan hover:underline">
                                    {(txHash as string).slice(0, 8)}...{(txHash as string).slice(-4)}
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>
                          {/* Step timeline */}
                          <div className="ml-12 mt-2 space-y-0.5">
                            {agentSteps.map((s, i) => {
                              const isSuccess = ['relay-confirmed','agent-completed'].includes(s.type) || (s.type === 'x402-payment' && s.checks?.responseUnlocked)
                              const isFail = ['relay-failed','agent-failed'].includes(s.type) || (s.type === 'x402-payment' && !s.checks?.responseUnlocked)
                              const isPending = ['relay-submitting','relay-waiting','x402-verifying','agent-working'].includes(s.type)
                              return (
                                <div key={i} className="flex items-center gap-1.5">
                                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isSuccess ? 'bg-green' : isFail ? 'bg-red' : isPending ? 'bg-amber-400 animate-pulse' : 'bg-t3/40'}`} />
                                  <span className="text-[10px] text-t3 truncate">{s.message}</span>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })
                  })()}
                </div>
              </motion.div>
            )}

            {/* Proof Trail */}
            {(onChainTxs.length > 0 || result?.sessionId) && (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                className="bg-surface border border-green/20 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-t2">Proof Trail</h2>
                  {pageState === 'running' && (
                    <span className="text-xs text-green animate-pulse">Live</span>
                  )}
                </div>
                {result?.sessionId ? (
                  <ProofTimeline sessionId={result.sessionId} />
                ) : (
                  <div className="space-y-2">
                    {onChainTxs.map((tx, i) => (
                      <div key={i} className="flex items-center justify-between bg-surface-2 border border-line rounded-xl px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${tx.txHash ? 'bg-green' : 'bg-amber-400 animate-pulse'}`} />
                          <span className="text-sm text-t2">{tx.label}</span>
                        </div>
                        {tx.txHash ? (
                          <a href={`https://basescan.org/tx/${tx.txHash}`} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-mono text-cyan hover:underline">
                            {tx.txHash.slice(0, 8)}...{tx.txHash.slice(-4)} {'->'}
                          </a>
                        ) : (
                          <span className="text-xs text-amber-400">Confirming...</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {result && !result.sessionId && (
                  <div className="flex justify-between text-xs text-t3 mt-3 pt-3 border-t border-line">
                    <span>Total: ${result.totalSpent}</span>
                    <span>Relay fees: ${result.relayFees || '0.00'}</span>
                    <span>All gasless via 1Shot</span>
                  </div>
                )}
              </motion.div>
            )}

            {/* Running spinner */}
            {pageState === 'running' && (
              <div className="flex items-center justify-center gap-3 py-4">
                <div className="w-5 h-5 border-2 border-purple border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-purple">
                  {steps.length === 0 ? 'Starting...' :
                   steps[steps.length - 1]?.type === 'synthesizing' ? 'Friday is writing your report...' :
                   'Friday is working...'}
                </span>
              </div>
            )}

            {/* ===== RESULTS ===== */}
            {pageState === 'complete' && result && (
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">

                {/* Report */}
                <div className="bg-surface border border-cyan/20 rounded-2xl p-5">
                  <h2 className="text-sm font-semibold text-t2 mb-4">Friday's Report</h2>
                  {result.reportImageUrl && (
                    <img src={result.reportImageUrl} alt="Report" className="w-full rounded-xl mb-4 border border-line" />
                  )}
                  <div className="prose prose-sm max-w-none text-t2 leading-relaxed whitespace-pre-wrap">
                    {result.report || 'Report generation in progress...'}
                  </div>
                </div>

                {/* Cost Summary */}
                <div className="bg-surface border border-line rounded-2xl p-5">
                  <h2 className="text-sm font-semibold text-t2 mb-4">Cost Summary</h2>
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div className="text-center bg-surface-2 rounded-xl py-3 border border-line">
                      <div className="text-lg font-bold text-gradient">${result.totalSpent}</div>
                      <div className="text-xs text-t3">Spent</div>
                    </div>
                    <div className="text-center bg-surface-2 rounded-xl py-3 border border-line">
                      <div className="text-lg font-bold text-green">${result.balanceRemaining || (parseFloat(budget) - parseFloat(result.totalSpent)).toFixed(2)}</div>
                      <div className="text-xs text-t3">Returned</div>
                    </div>
                    <div className="text-center bg-surface-2 rounded-xl py-3 border border-line">
                      <div className="text-lg font-bold text-purple">{result.selectedAgents.length}</div>
                      <div className="text-xs text-t3">Agents Hired</div>
                    </div>
                  </div>

                  {/* Per-agent cost table */}
                  <div className="space-y-1.5">
                    {result.relayResults?.map((r, i) => (
                      <div key={i} className="flex items-center justify-between text-sm bg-surface-2 rounded-lg px-3 py-2">
                        <span className="text-t2">{r.agentName}</span>
                        {r.txHash && (
                          <a href={`https://basescan.org/tx/${r.txHash}`} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-cyan hover:underline font-mono">BaseScan</a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* x402 Payment Verification */}
                {(result.x402Results && result.x402Results.length > 0 || steps.some(s => s.type === 'x402-payment')) && (
                  <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/80 p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-zinc-200">x402 Payment Verification</h3>
                    <div className="space-y-3">
                      {(result.x402Results || steps.filter(s => s.type === 'x402-payment').map(s => ({
                        agentName: s.agentName || '',
                        http402Received: s.checks?.http402Received || false,
                        paymentSignatureSent: s.checks?.paymentSignatureSent || false,
                        priorPaymentVerified: s.checks?.priorPaymentVerified || false,
                        responseUnlocked: s.checks?.responseUnlocked || false,
                        priorPaymentTxHash: s.checks?.priorPaymentTxHash || null,
                      }))).map((x, i) => (
                        <div key={i} className="bg-surface-2 rounded-lg p-3 space-y-2">
                          <div className="text-xs text-zinc-400 mb-1">
                            MetaMask ERC-7710 permission → 1Shot on-chain payment → x402 verified prior payment → response unlocked for <span className="text-zinc-200 font-medium">{x.agentName}</span>.
                          </div>
                          <div className="grid grid-cols-2 gap-1">
                            {[
                              { label: 'HTTP 402 received', ok: x.http402Received },
                              { label: 'PAYMENT-SIGNATURE sent', ok: x.paymentSignatureSent },
                              { label: '1Shot payment verified on-chain', ok: x.priorPaymentVerified },
                              { label: 'Agent response unlocked', ok: x.responseUnlocked },
                            ].map((c, j) => (
                              <div key={j} className="flex items-center gap-1.5 text-[11px]">
                                <span className={c.ok ? 'text-green' : 'text-zinc-500'}>{c.ok ? '✓' : '•'}</span>
                                <span className={c.ok ? 'text-zinc-300' : 'text-zinc-500'}>{c.label}</span>
                              </div>
                            ))}
                          </div>
                          {x.priorPaymentTxHash && (
                            <a href={`https://basescan.org/tx/${x.priorPaymentTxHash}`} target="_blank" rel="noopener noreferrer"
                              className="text-[10px] text-cyan hover:underline font-mono block mt-1">
                              {x.priorPaymentTxHash.slice(0, 10)}...{x.priorPaymentTxHash.slice(-8)}
                            </a>
                          )}
                          <div className="flex gap-3 text-[10px] text-zinc-500 mt-1">
                            <span>Settled: 1Shot Relay</span>
                            <span>Verified: On-chain TX</span>
                            <span>Facilitator: none</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Hackathon Verification */}
                <HackathonVerification
                  upgradeProof={upgradeProof}
                  delegationActive={saStatus === 'smart-account'}
                  delegator={walletAddr}
                  relayResults={result.relayResults?.map(r => ({ agentName: r.agentName, txHash: r.txHash }))}
                  x402Payments={result.x402Results}
                  onChainCount={result.relayResults?.filter(r => r.txHash).length || 0}
                  offChainCount={result.selectedAgents.length}
                />

                {/* Friday Learned */}
                {result.skillLearned && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}
                    className="bg-gradient-to-r from-purple/5 to-pink/5 border border-purple/20 rounded-2xl p-5">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">{'💡'}</span>
                      <h2 className="text-sm font-semibold text-purple">Friday Learned</h2>
                    </div>
                    <p className="text-sm text-t2">{result.skillLearned}</p>
                  </motion.div>
                )}

                {/* Actions */}
                <div className="flex gap-3">
                  <button onClick={reset}
                    className="flex-1 py-3 rounded-xl font-semibold text-sm bg-gradient-to-r from-purple to-pink text-white hover:opacity-90 transition-all">
                    Hire Again
                  </button>
                  <button onClick={() => navigator.clipboard.writeText(result.report || '')}
                    className="px-4 py-3 rounded-xl text-sm font-medium bg-surface-2 border border-line text-t2 hover:text-t1 transition-all">
                    Copy Report
                  </button>
                </div>
              </motion.div>
            )}

            {/* ===== ERROR ===== */}
            {pageState === 'error' && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                <div className="bg-surface border border-red/20 rounded-2xl p-5">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-lg bg-red/10 border border-red/20 flex items-center justify-center text-red">!</div>
                    <h2 className="font-semibold text-red">
                      {steps.some(s => s.type === 'x402-payment' && s.message?.includes('verified')) ? 'Flow Partially Completed' : 'Something went wrong'}
                    </h2>
                  </div>
                  <p className="text-sm text-t2">{error}</p>
                  {steps.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {steps.filter(s => s.type === 'x402-payment').map((s, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className={s.message?.includes('verified') ? 'text-green' : 'text-red'}>
                            {s.message?.includes('verified') ? 'Paid' : 'Failed'}
                          </span>
                          <span className="text-t3">{s.agentName}</span>
                          {(s as any).checks?.priorPaymentTxHash && (
                            <a href={`https://basescan.org/tx/${(s as any).checks.priorPaymentTxHash}`} target="_blank" rel="noopener noreferrer" className="text-cyan underline">
                              {((s as any).checks.priorPaymentTxHash as string).slice(0, 10)}...
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {result?.report && (
                    <div className="mt-3 p-3 bg-surface-2 rounded-xl border border-line">
                      <p className="text-xs text-t3 mb-1">Partial report available:</p>
                      <p className="text-sm text-t2 line-clamp-4">{result.report.slice(0, 300)}...</p>
                      <button onClick={() => navigator.clipboard.writeText(result.report || '')} className="mt-2 text-xs text-cyan underline">
                        Copy full report
                      </button>
                    </div>
                  )}
                </div>
                <button onClick={reset}
                  className="w-full py-3 rounded-xl font-semibold text-sm bg-surface-2 border border-line text-t2 hover:text-t1">
                  Try Again
                </button>
              </motion.div>
            )}
          </div>
        )}

        {/* ===== FRIDAY ACTIVITY ===== */}
        {activity && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="mt-8 space-y-5">

            {/* Stats */}
            {activity.stats.totalJobs > 0 && (
              <div className="bg-surface border border-line rounded-2xl p-5">
                <h2 className="text-sm font-semibold text-t2 mb-4">Friday Track Record</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="text-center bg-surface-2 rounded-xl py-3 border border-line">
                    <div className="text-lg font-bold text-gradient">{activity.stats.completedJobs}</div>
                    <div className="text-[10px] text-t3">Jobs Completed</div>
                  </div>
                  <div className="text-center bg-surface-2 rounded-xl py-3 border border-line">
                    <div className="text-lg font-bold text-purple">${activity.stats.totalSpent}</div>
                    <div className="text-[10px] text-t3">USDC Processed</div>
                  </div>
                  <div className="text-center bg-surface-2 rounded-xl py-3 border border-line">
                    <div className="text-lg font-bold text-cyan">{activity.stats.totalAgentsHired}</div>
                    <div className="text-[10px] text-t3">Agents Hired</div>
                  </div>
                  <div className="text-center bg-surface-2 rounded-xl py-3 border border-line">
                    <div className="text-lg font-bold text-green">{activity.stats.totalOnChainTx}</div>
                    <div className="text-[10px] text-t3">On-chain Txs</div>
                  </div>
                </div>
                {activity.stats.avgCompletionSeconds > 0 && (
                  <div className="flex justify-center gap-6 mt-3 text-xs text-t3">
                    <span>Avg completion: {Math.floor(activity.stats.avgCompletionSeconds / 60)}m {activity.stats.avgCompletionSeconds % 60}s</span>
                    <span>Success rate: {activity.stats.successRate}%</span>
                  </div>
                )}
              </div>
            )}

            {/* Job History */}
            <div className="bg-surface border border-line rounded-2xl p-5">
              <h2 className="text-sm font-semibold text-t2 mb-3">Friday Activity</h2>
              {activity.jobs.length === 0 ? (
                <p className="text-sm text-t3 text-center py-4">No verified hires yet. Run Friday once to generate real proof.</p>
              ) : (
                <div className="space-y-2">
                  {activity.jobs.slice(0, 10).map(job => (
                    <div key={job.sessionId} className="bg-surface-2 border border-line rounded-xl p-3 hover:border-purple/20 transition-colors">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-t1 truncate flex-1 mr-3">{job.task}</p>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border flex-shrink-0 ${
                          job.status === 'complete' ? 'bg-green/10 border-green/20 text-green' : 'bg-amber-400/10 border-amber-400/20 text-amber-400'
                        }`}>{job.status === 'complete' ? 'Completed' : 'Running'}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-xs text-t3">{job.agentCount} agent{job.agentCount !== 1 ? 's' : ''}</span>
                        <span className="text-xs text-purple font-medium">${job.spent}</span>
                        {job.txCount > 0 && (
                          <span className="text-xs text-green">{job.txCount} on-chain</span>
                        )}
                        <span className="text-[10px] text-t3 ml-auto">{new Date(job.createdAt).toLocaleString()}</span>
                      </div>
                      {job.txHashes.length > 0 && (
                        <div className="flex gap-1.5 mt-2">
                          {job.txHashes.map((tx, i) => (
                            <a key={i} href={`https://basescan.org/tx/${tx}`} target="_blank" rel="noopener noreferrer"
                              className="text-[10px] px-1.5 py-0.5 rounded bg-green/10 border border-green/20 text-green hover:bg-green/20 font-mono">
                              {tx.slice(0, 10)}...
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Top Agents */}
            {activity.topAgents.length > 0 && (
              <div className="bg-surface border border-line rounded-2xl p-5">
                <h2 className="text-sm font-semibold text-t2 mb-3">Friday's Workforce</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {activity.topAgents.map(a => (
                    <div key={a.slug} className="bg-surface-2 border border-line rounded-xl p-3 text-center">
                      <div className="text-sm font-semibold text-t1 truncate">{a.slug}</div>
                      <div className="text-xs text-purple mt-0.5">{a.timesHired}x hired</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* ===== FOOTER ===== */}
        <div className="mt-12 pt-6 border-t border-line text-center space-y-2">
          <p className="text-xs text-t3">
            Friday is powered by <span className="text-purple">GenericAgent</span> framework
            {' '}on <a href="https://workagnt.ai" className="text-cyan hover:underline">WorkAgnt.ai</a>
          </p>
          <div className="flex justify-center gap-4 text-[10px] text-t3">
            <span>MetaMask Smart Account (EIP-7702)</span>
            <span>ERC-7710 Delegation</span>
            <span>1Shot Gasless Relay</span>
            <span>x402 Protocol</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentCard({ agent, callInfo, status }: {
  agent: { slug: string; name: string; description: string }
  callInfo?: { agentName: string; callCount: number; subtask: string }
  status: 'working' | 'paying' | 'done'
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
      className="bg-surface-2 border border-line rounded-xl p-3 hover:border-purple/20 transition-colors">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-purple/20 to-pink/20 border border-purple/20 flex items-center justify-center text-lg flex-shrink-0">
          {'🤖'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-t1 truncate">{agent.name}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${
              status === 'done' ? 'bg-green/10 border-green/20 text-green' :
              status === 'paying' ? 'bg-amber-400/10 border-amber-400/20 text-amber-400' :
              'bg-purple/10 border-purple/20 text-purple'
            }`}>
              {status === 'done' ? 'Hired' : status === 'paying' ? 'Paying...' : 'Working...'}
            </span>
          </div>
          {callInfo?.subtask && (
            <p className="text-xs text-t3 mt-0.5 line-clamp-1">{callInfo.subtask}</p>
          )}
        </div>
      </div>
      {callInfo && status === 'done' && (
        <button onClick={() => setExpanded(!expanded)} className="text-xs text-purple mt-2 ml-12">
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      )}
      {expanded && callInfo && (
        <div className="mt-2 ml-12 text-xs text-t3 bg-surface rounded-lg p-2 border border-line">
          {callInfo.callCount} x402 call{callInfo.callCount > 1 ? 's' : ''} made
        </div>
      )}
    </motion.div>
  )
}
