import { Router, type Request, type Response } from 'express'
import { storeDelegation, getDelegation, getDelegationChain, getAllDelegations, revokeDelegation, type DelegationRecord } from '../lib/delegation-manager.js'
import { startDelegateFlow, getFlowRun, type FlowStep } from '../lib/delegateflow-orchestrator.js'
import { getFeeData, getCapabilities } from '../lib/oneshot-relayer.js'
import { veniceChat } from '../lib/venice-ai.js'
import { parseUnits, type Address } from 'viem'
import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

const router = Router()

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
      slug: schema.agents.slug,
      name: schema.agents.name,
      description: schema.agents.description,
      category: schema.agents.category,
      pricing: schema.agents.pricing,
      x402PriceUsdc: schema.agents.x402PriceUsdc,
      agentWalletAddress: schema.agents.agentWalletAddress,
    })
      .from(schema.agents)
      .where(and(eq(schema.agents.isPublished, true), eq(schema.agents.isActive, true)))
      .limit(50)

    const agents = agentsResult.map((a: typeof agentsResult[number]) => ({
      slug: a.slug,
      name: a.name,
      description: a.description || '',
      category: a.category || 'general',
      pricing: {
        model: a.pricing || 'free',
        x402Price: a.x402PriceUsdc || null,
      },
      walletAddress: a.agentWalletAddress || undefined,
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

export default router
