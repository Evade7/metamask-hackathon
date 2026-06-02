import { Router, type Request, type Response } from 'express'
import { storeDelegation, getDelegation, getDelegationChain, getAllDelegations, revokeDelegation, type DelegationRecord } from '../lib/delegation-manager.js'
import { startDelegateFlow, getFlowRun, type FlowStep } from '../lib/delegateflow-orchestrator.js'
import {
  getFeeData, getCapabilities, relaySend7710Transaction, estimate7710Transaction,
  getRelayTask, updateRelayTask, pollAndUpdateTask,
  storeRelayTask, relay7702Authorization, type RelayTask,
} from '../lib/oneshot-relayer.js'
import { veniceChat } from '../lib/venice-ai.js'
import { emitProofEvent, confirmProofEvent } from '../lib/proof-layer.js'
import { parseUnits, type Address } from 'viem'
import { eq, and, isNotNull, ne, lt } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

const router = Router()

const LOCK_TTL_MS = 10 * 60 * 1000

async function acquireDelegateFlowLock(delegationId: string): Promise<boolean> {
  try {
    const tenMinutesAgo = new Date(Date.now() - LOCK_TTL_MS)
    const stale = await db.delete(schema.delegateflowLocks)
      .where(lt(schema.delegateflowLocks.createdAt, tenMinutesAgo))
      .returning({ delegationId: schema.delegateflowLocks.delegationId, createdAt: schema.delegateflowLocks.createdAt })
    if (stale.length > 0) {
      console.log(JSON.stringify({
        event: 'delegateflow.stale_locks_cleaned',
        deletedCount: stale.length,
        locks: stale.map(s => ({
          delegationId: s.delegationId,
          ageMinutes: parseFloat(((Date.now() - new Date(s.createdAt).getTime()) / 60000).toFixed(1)),
        })),
      }))
    }

    await db.insert(schema.delegateflowLocks).values({ delegationId, status: 'active' })
    return true
  } catch (err: any) {
    if (err?.code === '23505') return false
    throw err
  }
}

async function releaseDelegateFlowLock(delegationId: string): Promise<void> {
  try {
    await db.delete(schema.delegateflowLocks).where(eq(schema.delegateflowLocks.delegationId, delegationId))
  } catch (err) {
    console.error(`[DelegateFlow] Failed to release lock for ${delegationId}:`, err)
  }
}

router.post('/delegation', async (req: Request, res: Response) => {
  try {
    const { delegator, delegate, maxAmountUsdc, expiresAt, signedDelegation } = req.body

    if (!delegator || !delegate || !maxAmountUsdc) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const record: DelegationRecord = {
      id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      delegator: delegator as Address,
      delegate: delegate as Address,
      parentId: null,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
      maxAmount: parseUnits(maxAmountUsdc, 6),
      amountRedeemed: 0n,
      expiresAt: expiresAt || Date.now() + 3600000,
      status: 'active',
      signedDelegation: signedDelegation || null,
      redeemTxHash: null,
      relayTaskId: null,
      createdAt: Date.now(),
    }

    storeDelegation(record)

    res.json({
      delegationId: record.id,
      delegator: record.delegator,
      delegate: record.delegate,
      maxAmount: maxAmountUsdc,
      expiresAt: record.expiresAt,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/delegation/:id', (req: Request, res: Response) => {
  const id = req.params.id as string
  const d = getDelegation(id)
  if (!d) return res.status(404).json({ error: 'Delegation not found' })
  res.json(serializeDelegation(d))
})

router.get('/delegation/:id/chain', (req: Request, res: Response) => {
  const id = req.params.id as string
  const chain = getDelegationChain(id)
  res.json({ chain: chain.map(serializeDelegation) })
})

router.delete('/delegation/:id', (req: Request, res: Response) => {
  const id = req.params.id as string
  revokeDelegation(id)
  res.json({ revoked: true })
})

router.post('/start', async (req: Request, res: Response) => {
  try {
    const { task, budget, delegationId } = req.body

    if (!task || !budget || !delegationId) {
      return res.status(400).json({ error: 'Missing task, budget, or delegationId' })
    }

    const delegation = getDelegation(delegationId)
    if (!delegation) {
      return res.status(404).json({ error: 'Delegation not found' })
    }

    const agentsResult = await db.select({
      id: schema.agents.id,
      slug: schema.agents.slug,
      name: schema.agents.name,
      description: schema.agents.description,
      category: schema.agents.category,
      pricing: schema.agents.pricing,
      x402PriceUsdc: schema.agents.x402PriceUsdc,
      agentWalletAddress: schema.agents.agentWalletAddress,
    })
      .from(schema.agents)
      .where(and(
        eq(schema.agents.isPublished, true),
        eq(schema.agents.isActive, true),
        isNotNull(schema.agents.agentWalletAddress),
        ne(schema.agents.agentWalletAddress, ''),
      ))
      .limit(50)

    const agents = agentsResult.map((a: typeof agentsResult[number]) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      description: a.description || '',
      category: a.category || 'general',
      pricing: {
        model: a.pricing || 'free',
        x402Price: a.x402PriceUsdc || null,
      },
      walletAddress: a.agentWalletAddress || undefined,
      x402Price: a.x402PriceUsdc || undefined,
    }))

    const steps: FlowStep[] = []
    const run = await startDelegateFlow({
      task,
      budget,
      rootDelegationId: delegationId,
      agents,
      onStep: (step) => steps.push(step),
    })

    res.json({
      flowId: run.id,
      status: run.status,
      steps: run.steps,
      selectedAgents: run.selectedAgents,
      report: run.report,
      reportImageUrl: run.reportImageUrl,
      totalSpent: run.totalSpent,
    })
  } catch (err: any) {
    console.error('[DelegateFlow] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

// SSE streaming version of /start — sends steps in real-time
router.post('/start/stream', async (req: Request, res: Response) => {
  let keepAlive: ReturnType<typeof setInterval> | null = null
  let lockAcquired = false
  let delegationId: string | undefined

  try {
    const { task, budget, delegationId: dId } = req.body
    delegationId = dId

    if (!task || !budget || !delegationId) {
      return res.status(400).json({ error: 'Missing task, budget, or delegationId' })
    }

    console.log(`[DelegateFlow/Stream] Starting: delegationId=${delegationId}, budget=$${budget}, task="${String(task).slice(0, 80)}"`)

    const delegation = getDelegation(delegationId)
    if (!delegation) {
      return res.status(404).json({ error: 'Delegation not found' })
    }

    lockAcquired = await acquireDelegateFlowLock(delegationId)
    if (!lockAcquired) {
      return res.status(409).json({ error: 'DelegateFlow already running for this delegation. Please wait for it to complete.' })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(`: keepalive\n\n`)
    }, 15000)

    req.on('close', () => {
      console.log(`[DelegateFlow] Client disconnected: ${delegationId}`)
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null }
      if (delegationId && lockAcquired) { releaseDelegateFlowLock(delegationId); lockAcquired = false }
    })

    const agentsResult = await db.select({
      id: schema.agents.id,
      slug: schema.agents.slug,
      name: schema.agents.name,
      description: schema.agents.description,
      category: schema.agents.category,
      pricing: schema.agents.pricing,
      x402PriceUsdc: schema.agents.x402PriceUsdc,
      agentWalletAddress: schema.agents.agentWalletAddress,
    })
      .from(schema.agents)
      .where(and(
        eq(schema.agents.isPublished, true),
        eq(schema.agents.isActive, true),
        isNotNull(schema.agents.agentWalletAddress),
        ne(schema.agents.agentWalletAddress, ''),
      ))
      .limit(50)

    const agents = agentsResult.map((a: typeof agentsResult[number]) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      description: a.description || '',
      category: a.category || 'general',
      pricing: {
        model: a.pricing || 'free',
        x402Price: a.x402PriceUsdc || null,
      },
      walletAddress: a.agentWalletAddress || undefined,
      x402Price: a.x402PriceUsdc || undefined,
    }))

    const run = await startDelegateFlow({
      task,
      budget,
      rootDelegationId: delegationId,
      agents,
      onStep: (step) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'step', step })}\n\n`)
      },
    })

    const completeStep = run.steps.find(s => s.type === 'complete') as any
    res.write(`data: ${JSON.stringify({
      type: 'complete',
      result: {
        flowId: run.id,
        sessionId: run.sessionId,
        status: run.status,
        steps: run.steps,
        selectedAgents: run.selectedAgents,
        report: run.report,
        reportImageUrl: run.reportImageUrl,
        totalSpent: run.totalSpent,
        budget: completeStep?.budget || budget,
        relayFees: completeStep?.relayFees || '0.00',
        balanceRemaining: completeStep?.balanceRemaining || '0.00',
        relayResults: completeStep?.relayResults || [],
        x402Results: completeStep?.x402Results || [],
        agentCalls: completeStep?.agentCalls || [],
      },
    })}\n\n`)
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null }
    if (delegationId && lockAcquired) { await releaseDelegateFlowLock(delegationId); lockAcquired = false }
    res.end()
  } catch (err: any) {
    console.error('[DelegateFlow/Stream] Error:', err)
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null }
    if (delegationId && lockAcquired) { await releaseDelegateFlowLock(delegationId); lockAcquired = false }
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`)
      res.end()
    }
  }
})

router.get('/run/:id', (req: Request, res: Response) => {
  const run = getFlowRun(req.params.id as string)
  if (!run) return res.status(404).json({ error: 'Flow run not found' })
  res.json({
    flowId: run.id,
    status: run.status,
    steps: run.steps,
    selectedAgents: run.selectedAgents,
    report: run.report,
    reportImageUrl: run.reportImageUrl,
    totalSpent: run.totalSpent,
  })
})

// Diagnostic: test x402 chain for a specific agent
router.get('/test-x402/:slug', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string
    const [target] = await db.select({
      slug: schema.agents.slug,
      name: schema.agents.name,
      x402Enabled: schema.agents.x402Enabled,
      x402PriceUsdc: schema.agents.x402PriceUsdc,
      agentWalletAddress: schema.agents.agentWalletAddress,
    }).from(schema.agents).where(eq(schema.agents.slug, slug)).limit(1)

    if (!target) return res.status(404).json({ error: 'Agent not found' })

    const step1 = { x402Enabled: target.x402Enabled, x402Price: target.x402PriceUsdc, wallet: target.agentWalletAddress }

    // Test: POST without payment headers → should get 402
    const port = process.env.PORT || 3001
    const testRes = await fetch(`http://localhost:${port}/api/v1/chat/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x402 diagnostic test' }),
      signal: AbortSignal.timeout(5000),
    })

    const step2 = { status: testRes.status, got402: testRes.status === 402 }

    let paymentRequired = null
    if (testRes.status === 402) {
      const headerRaw = testRes.headers.get('payment-required')
      if (headerRaw) {
        try { paymentRequired = JSON.parse(Buffer.from(headerRaw, 'base64').toString()) } catch {}
      }
      if (!paymentRequired) {
        const body = await testRes.json().catch(() => ({}))
        paymentRequired = body.accepts ? body : null
      }
    }

    const step3 = { hasPaymentRequired: !!paymentRequired, acceptsCount: paymentRequired?.accepts?.length || 0, payTo: paymentRequired?.accepts?.[0]?.payTo?.slice(0, 12) || null }

    res.json({ agent: target.name, slug, diagnostics: { agentConfig: step1, postWithoutPayment: step2, paymentRequiredParsed: step3 } })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/relay/fee', async (_req: Request, res: Response) => {
  try {
    const fee = await getFeeData()
    res.json(fee)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/relay/capabilities', async (_req: Request, res: Response) => {
  try {
    const caps = await getCapabilities()
    res.json(caps)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ─── 1Shot Relay: Estimate ERC-7710 Bundle (relayer_estimate7710Transaction) ───

router.post('/relay/estimate7710', async (req: Request, res: Response) => {
  try {
    const { chainId, transactions, authorizationList } = req.body

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'transactions array required' })
    }

    console.log(`[Relay/Estimate] Estimating delegation bundle (${transactions.length} txs)`)

    const result = await estimate7710Transaction({
      chainId: chainId || '8453',
      transactions,
      authorizationList: authorizationList || [],
    })

    console.log(`[Relay/Estimate] Result: success=${result.success} gas=${result.gasUsed} fee=${result.requiredPaymentAmount}`)
    res.json(result)
  } catch (err: any) {
    console.error('[Relay/Estimate] Error:', err?.message || err)
    res.status(500).json({
      error: 'Failed to estimate delegation bundle',
      details: err?.message || 'Unknown error',
    })
  }
})

// ─── 1Shot Relay: ERC-7710 Delegation Bundle (relayer_send7710Transaction) ───

router.post('/relay/send7710', async (req: Request, res: Response) => {
  try {
    const { chainId, context, transactions, authorizationList } = req.body

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: 'transactions array required' })
    }

    console.log(`[Relay/7710] Submitting delegation bundle (${transactions.length} txs)`)

    const webhookUrl = `${req.protocol}://${req.get('host')}/api/delegateflow/relay/webhook`

    const taskId = await relaySend7710Transaction({
      chainId: chainId || '8453',
      transactions,
      authorizationList: authorizationList || [],
      context,
      destinationUrl: webhookUrl,
    })

    const task: RelayTask = {
      taskId,
      type: '7710',
      status: 'submitted',
      txHash: null,
      blockNumber: null,
      address: 'delegation-bundle',
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    storeRelayTask(task)

    console.log(`[Relay/7710] Submitted: taskId=${taskId} webhook=${webhookUrl}`)
    res.json({
      taskId,
      status: 'submitted',
      message: 'ERC-7710 delegation bundle submitted to 1Shot (USDC gas abstraction)',
    })
  } catch (err: any) {
    console.error('[Relay/7710] Error:', err?.message || err)
    res.status(500).json({
      error: 'Failed to relay delegation bundle',
      details: err?.message || 'Unknown error',
    })
  }
})

// ─── 1Shot Relay: Webhook callback (1Shot pushes status updates here) ───

router.post('/relay/webhook', async (req: Request, res: Response) => {
  try {
    const { taskId, status, txHash, blockNumber, error: webhookError } = req.body
    console.log(`[Relay/Webhook] Received: taskId=${taskId} status=${status} txHash=${txHash || 'none'}`)

    if (!taskId) {
      return res.status(400).json({ error: 'taskId required' })
    }

    const task = getRelayTask(taskId)
    if (!task) {
      console.warn(`[Relay/Webhook] Unknown taskId: ${taskId}`)
      return res.status(200).json({ ok: true, message: 'Task not tracked locally' })
    }

    const statusMap: Record<string, 'pending' | 'submitted' | 'confirmed' | 'failed'> = {
      'Pending': 'submitted',
      'Confirmed': 'confirmed',
      'Rejected': 'failed',
      'Reverted': 'failed',
    }

    const mappedStatus = statusMap[status] || task.status
    updateRelayTask(taskId, {
      status: mappedStatus,
      txHash: txHash || task.txHash,
      blockNumber: blockNumber || task.blockNumber,
      error: webhookError || (mappedStatus === 'failed' ? `Relay ${status}` : null),
    })

    console.log(`[Relay/Webhook] Task ${taskId} updated to ${mappedStatus}`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[Relay/Webhook] Error:', err?.message || err)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
})

// ─── 1Shot Relay: Poll task status ───

router.get('/relay/status/:taskId', async (req: Request, res: Response) => {
  try {
    const taskId = req.params.taskId as string

    const task = await pollAndUpdateTask(taskId)
    if (!task) {
      return res.status(404).json({ error: 'Task not found' })
    }

    if (task.status === 'confirmed' && task.txHash && task.type === '7702') {
      confirmProofEvent(taskId, task.txHash, task.blockNumber || undefined)
    }

    const baseScanUrl = task.txHash ? `https://basescan.org/tx/${task.txHash}` : null
    res.json({
      taskId: task.taskId,
      type: task.type,
      status: task.status,
      txHash: task.txHash,
      blockNumber: task.blockNumber,
      address: task.address,
      error: task.error,
      baseScanUrl,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })
  } catch (err: any) {
    console.error('[Relay/Status] Error:', err?.message || err)
    res.status(500).json({ error: 'Failed to fetch relay status' })
  }
})

// ─── 1Shot Relay: EIP-7702 EOA → Smart Account upgrade ───

router.post('/relay/7702', async (req: Request, res: Response) => {
  try {
    const { authorization, signerAddress } = req.body

    if (!authorization || !signerAddress) {
      return res.status(400).json({ error: 'authorization and signerAddress required' })
    }

    console.log(`[Relay/7702] Upgrading EOA → Smart Account: ${signerAddress}`)

    const result = await relay7702Authorization({ authorization, signerAddress })

    console.log(`[Relay/7702] Submitted: taskId=${result.taskId}`)

    emitProofEvent({
      type: 'eip7702-upgrade',
      actorType: 'user',
      actorId: signerAddress,
      status: 'submitted',
      relayTaskId: result.taskId,
      fromAddress: signerAddress,
      label: `EIP-7702 Smart Account upgrade: ${signerAddress.slice(0, 8)}...`,
      proofSource: 'on-chain',
    })

    res.json({
      taskId: result.taskId,
      feeContext: result.feeContext,
      status: 'submitted',
      message: 'EIP-7702 authorization relayed through 1Shot',
    })
  } catch (err: any) {
    console.error('[Relay/7702] Error:', err?.message || err)
    res.status(500).json({
      error: 'Failed to relay 7702 authorization',
      details: err?.message || 'Unknown error',
    })
  }
})

router.post('/venice/chat', async (req: Request, res: Response) => {
  try {
    const { messages, model } = req.body
    const result = await veniceChat(messages, { model })
    res.json(result)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

function serializeDelegation(d: DelegationRecord) {
  return {
    id: d.id,
    delegator: d.delegator,
    delegate: d.delegate,
    parentId: d.parentId,
    tokenAddress: d.tokenAddress,
    maxAmount: (Number(d.maxAmount) / 1e6).toFixed(2),
    amountRedeemed: (Number(d.amountRedeemed) / 1e6).toFixed(2),
    expiresAt: d.expiresAt,
    status: d.status,
    redeemTxHash: d.redeemTxHash,
    relayTaskId: d.relayTaskId,
    createdAt: d.createdAt,
  }
}

// Run history endpoints
router.get('/runs', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    const runs = await db.select().from(schema.delegateFlowRuns)
      .where(eq(schema.delegateFlowRuns.userId, userId))
      .orderBy(schema.delegateFlowRuns.createdAt)
      .limit(50)

    res.json({ runs })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/runs/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })

    const runId = req.params.id as string
    const [run] = await db.select().from(schema.delegateFlowRuns)
      .where(
        and(
          eq(schema.delegateFlowRuns.id, runId),
          eq(schema.delegateFlowRuns.userId, userId),
        )
      )
      .limit(1)

    if (!run) return res.status(404).json({ error: 'Run not found' })

    const agentCalls = await db.select().from(schema.delegateFlowAgentCalls)
      .where(eq(schema.delegateFlowAgentCalls.runId, run.id))

    res.json({ run, agentCalls })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

export default router
