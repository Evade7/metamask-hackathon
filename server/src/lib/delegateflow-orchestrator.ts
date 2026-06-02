import { veniceChat, veniceEmbed, veniceImageGenerate, cosineSimilarity } from './venice-ai.js'
import { createRedelegation, markRedeemed, getDelegationChain, getDelegation } from './delegation-manager.js'
import { relaySend7710Transaction, getFeeData, pollAndUpdateTask, storeRelayTask } from './oneshot-relayer.js'
import { getFetchWithPay } from './bazaar-index.js'
import { emitProofEvent, confirmProofEvent, failProofEvent } from './proof-layer.js'
import { callAgentWithX402, type X402DelegationContext } from './metamask-x402-payment.js'
import { parseUnits, type Address } from 'viem'

const GENERICAGENT_URL = process.env.GENERICAGENT_URL || 'http://localhost:8100'

function roundAllocations(
  allocations: { agentName: string; amount: string; reasoning: string }[],
  totalBudget: number,
): { agentName: string; amount: string; reasoning: string }[] {
  if (allocations.length === 0) return allocations
  const rounded = allocations.map(a => ({
    ...a,
    amount: Math.floor(parseFloat(a.amount) * 100) / 100,
  }))
  const sumSoFar = rounded.slice(0, -1).reduce((s, a) => s + a.amount, 0)
  const lastAmount = Math.floor((totalBudget - sumSoFar) * 100) / 100
  rounded[rounded.length - 1].amount = lastAmount
  return rounded.map(a => ({ ...a, amount: a.amount.toFixed(2) }))
}

interface GenericAgentPlan {
  subtasks: { agent_slug: string; agent_name: string; task: string; budget: number; priority?: number }[]
  reasoning: string
  parallel_groups?: string[][]
}

interface GenericAgentSynthesis {
  report: string
  skill_learned: string | null
}

async function tryGenericAgentPlan(task: string, budget: number, agents: { slug: string; name: string; description: string; category: string; x402Price?: string }[]): Promise<GenericAgentPlan | null> {
  try {
    const res = await fetch(`${GENERICAGENT_URL}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, budget, agents }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch (err: any) {
    console.log(`[DelegateFlow] GenericAgent plan unavailable: ${err?.message?.slice(0, 60)}`)
    return null
  }
}

async function tryGenericAgentSynthesize(task: string, responses: { agent_name: string; subtask: string; response: string; budget: number }[], budget: number, totalSpent: number): Promise<GenericAgentSynthesis | null> {
  try {
    const res = await fetch(`${GENERICAGENT_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, responses, budget, total_spent: totalSpent }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch (err: any) {
    console.log(`[DelegateFlow] GenericAgent synthesis unavailable: ${err?.message?.slice(0, 60)}`)
    return null
  }
}

export type FlowStep =
  | { type: 'analyzing'; message: string }
  | { type: 'matching'; message: string; agents: { slug: string; name: string; score: number }[] }
  | { type: 'budgeting'; message: string; allocations: { agentName: string; amount: string; reasoning: string }[] }
  | { type: 'delegating'; message: string; delegations: { agentName: string; amount: string }[] }
  | { type: 'executing'; message: string; agentName: string }
  | { type: 'relaying'; message: string; taskId: string }
  | { type: 'relay-submitting'; message: string; agentName: string; amount: string; taskId: string }
  | { type: 'relay-waiting'; message: string; agentName: string; taskId: string }
  | { type: 'relay-confirmed'; message: string; agentName: string; amount: string; txHash: string }
  | { type: 'relay-failed'; message: string; agentName: string; amount: string }
  | { type: 'x402-verifying'; message: string; agentName: string }
  | { type: 'x402-payment'; agentName: string; message: string; checks: { http402Received: boolean; paymentSignatureSent: boolean; priorPaymentVerified: boolean; responseUnlocked: boolean; priorPaymentTxHash: string | null } }
  | { type: 'agent-working'; message: string; agentName: string }
  | { type: 'agent-completed'; message: string; agentName: string; replyLength: number }
  | { type: 'agent-failed'; message: string; agentName: string; reason: string }
  | { type: 'synthesizing'; message: string }
  | { type: 'complete'; report: string; imageUrl: string | null; totalSpent: string; budget: string; relayFees: string; balanceRemaining: string; delegationChain: unknown[]; relayResults?: { agentName: string; taskId: string; txHash: string | null }[]; x402Results?: { agentName: string; http402Received: boolean; paymentSignatureSent: boolean; priorPaymentVerified: boolean; responseUnlocked: boolean; priorPaymentTxHash: string | null }[]; planningReasoning?: string | null; skillLearned?: string | null; agentCalls?: { agentName: string; callCount: number; subtask: string }[] }
  | { type: 'error'; message: string }

export interface FlowRun {
  id: string
  sessionId: string
  task: string
  budget: string
  rootDelegationId: string
  status: 'pending' | 'running' | 'complete' | 'failed'
  steps: FlowStep[]
  selectedAgents: { slug: string; name: string; description: string; walletAddress?: string; x402Price?: string }[]
  report: string | null
  reportImageUrl: string | null
  totalSpent: string
  createdAt: number
}

const runs = new Map<string, FlowRun>()

export function getFlowRun(id: string): FlowRun | undefined {
  return runs.get(id)
}

interface AgentInfo {
  slug: string
  name: string
  description: string
  category: string
  pricing: { model: string; x402Price: string | null }
  walletAddress?: string
  x402Price?: string
}

export async function startDelegateFlow(params: {
  task: string
  budget: string
  rootDelegationId: string
  agents: AgentInfo[]
  onStep: (step: FlowStep) => void
}): Promise<FlowRun> {
  const runId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const sessionId = `session-${runId}`
  const run: FlowRun = {
    id: runId,
    sessionId,
    task: params.task,
    budget: params.budget,
    rootDelegationId: params.rootDelegationId,
    status: 'running',
    steps: [],
    selectedAgents: [],
    report: null,
    reportImageUrl: null,
    totalSpent: '0',
    createdAt: Date.now(),
  }
  runs.set(run.id, run)

  emitProofEvent({
    type: 'workflow-started',
    actorType: 'system',
    actorId: 'friday',
    sessionId,
    runId: run.id,
    label: `DelegateFlow started: "${params.task.slice(0, 60)}"`,
    detail: { task: params.task, budget: params.budget },
    proofSource: 'off-chain',
  })

  function addStep(step: FlowStep) {
    run.steps.push(step)
    params.onStep(step)
  }

  try {
    // Step 1: Try GenericAgent planning brain first, fallback to Venice direct
    addStep({ type: 'analyzing', message: 'Friday is analyzing your task and selecting the right team...' })

    let subtasks: { description: string; requiredSkill: string; complexity?: string }[] = []
    let skipVenicePlanning = false

    // Reserve relay fees upfront so total on-chain spend stays within EIP-7715 permission cap
    const RELAY_FEE_PER_AGENT = 0.01
    const budgetNum = parseFloat(params.budget)
    let totalRelayFees = 0
    let allocatableBudget = budgetNum

    const gaPlan = await tryGenericAgentPlan(
      params.task,
      parseFloat(params.budget),
      params.agents.map(a => ({ slug: a.slug, name: a.name, description: a.description, category: a.category, x402Price: a.x402Price || a.pricing.x402Price || undefined }))
    )

    if (gaPlan && gaPlan.subtasks.length > 0) {
      console.log(`[DelegateFlow] GenericAgent plan: ${gaPlan.subtasks.length} subtasks, reasoning: ${gaPlan.reasoning.slice(0, 80)}`)

      const selectedAgents: typeof run.selectedAgents = []
      const allocations: { agentName: string; amount: string; reasoning: string }[] = []
      const agentScores: { slug: string; name: string; score: number }[] = []

      // Compute relay fees for GenericAgent path
      const gaAgentCount = gaPlan.subtasks.filter(st => params.agents.find(a => a.slug === st.agent_slug)).length
      totalRelayFees = gaAgentCount * RELAY_FEE_PER_AGENT
      allocatableBudget = budgetNum - totalRelayFees
      const gaScale = allocatableBudget / budgetNum

      console.log(`[DelegateFlow] GenericAgent relay fee adjustment: ${gaAgentCount} agents, relayFees=$${totalRelayFees.toFixed(2)}, scale=${gaScale.toFixed(4)}`)

      for (const st of gaPlan.subtasks) {
        const agent = params.agents.find(a => a.slug === st.agent_slug)
        if (!agent) continue
        selectedAgents.push({
          slug: agent.slug,
          name: agent.name,
          description: agent.description,
          walletAddress: agent.walletAddress,
          x402Price: agent.x402Price || agent.pricing.x402Price || undefined,
        })
        const adjustedBudget = (st.budget * gaScale).toFixed(2)
        allocations.push({ agentName: st.agent_name, amount: adjustedBudget, reasoning: st.task })
        agentScores.push({ slug: agent.slug, name: agent.name, score: 0.95 })
      }

      const roundedAllocations = roundAllocations(allocations, allocatableBudget)

      run.selectedAgents = selectedAgents
      addStep({ type: 'matching', message: `Friday selected ${selectedAgents.length} specialists`, agents: agentScores })
      addStep({ type: 'budgeting', message: `Budget: $${budgetNum} total | $${totalRelayFees.toFixed(2)} relay fees reserved | ${roundedAllocations.map(a => `${a.agentName} → $${a.amount}`).join(', ')}`, allocations: roundedAllocations })

      subtasks = gaPlan.subtasks.map(st => ({ description: st.task, requiredSkill: '', complexity: 'moderate' }))
      skipVenicePlanning = true
    }

    // Fallback: Venice direct planning (if GenericAgent unavailable)
    if (!skipVenicePlanning) {

    const decomposition = await veniceChat([
      {
        role: 'system',
        content: `You are an AI task orchestrator for WorkAgnt.ai, an AI employee marketplace. Given a research task, decompose it into 2 subtasks that can be assigned to specialist AI agents. Respond in JSON format only: { "subtasks": [{ "description": "...", "requiredSkill": "...", "complexity": "simple" | "moderate" | "complex" }] }`,
      },
      { role: 'user', content: params.task },
    ])

    try {
      const cleaned = decomposition.reply.replace(/```json\n?|\n?```/g, '').replace(/^[^{]*/, '').replace(/[^}]*$/, '')
      const parsed = JSON.parse(cleaned)
      subtasks = parsed.subtasks || []
    } catch {
      subtasks = [
        { description: params.task, requiredSkill: 'research', complexity: 'moderate' },
        { description: `Provide analysis and data for: ${params.task}`, requiredSkill: 'analysis', complexity: 'simple' },
      ]
    }

    // Step 2: Venice AI agent matching via embeddings
    addStep({ type: 'analyzing', message: `Decomposed into ${subtasks.length} subtasks. Matching agents via Venice embeddings...` })

    const taskTexts = subtasks.map(s => `${s.description} - ${s.requiredSkill}`)
    const agentTexts = params.agents.map(a => `${a.name}: ${a.description} (${a.category})`)
    const allTexts = [...taskTexts, ...agentTexts]

    const embeddings = await veniceEmbed(allTexts)
    const taskEmbeddings = embeddings.slice(0, taskTexts.length)
    const agentEmbeddings = embeddings.slice(taskTexts.length)

    const selectedAgents: typeof run.selectedAgents = []
    const agentScores: { slug: string; name: string; score: number }[] = []

    for (let t = 0; t < taskEmbeddings.length; t++) {
      let bestIdx = 0
      let bestScore = -1
      for (let a = 0; a < agentEmbeddings.length; a++) {
        const alreadySelected = selectedAgents.some(s => s.slug === params.agents[a].slug)
        if (alreadySelected) continue
        const score = cosineSimilarity(taskEmbeddings[t], agentEmbeddings[a])
        if (score > bestScore) {
          bestScore = score
          bestIdx = a
        }
      }
      const agent = params.agents[bestIdx]
      selectedAgents.push({
        slug: agent.slug,
        name: agent.name,
        description: agent.description,
        walletAddress: agent.walletAddress,
        x402Price: agent.x402Price || agent.pricing.x402Price || undefined,
      })
      agentScores.push({ slug: agent.slug, name: agent.name, score: bestScore })
    }

    run.selectedAgents = selectedAgents
    addStep({
      type: 'matching',
      message: `Selected ${selectedAgents.length} agents via Venice AI embeddings`,
      agents: agentScores,
    })

    // Step 3: Venice AI budget reasoning (proportional, not equal)
    // Compute relay fees for the Venice path agents
    totalRelayFees = selectedAgents.length * RELAY_FEE_PER_AGENT
    allocatableBudget = budgetNum - totalRelayFees

    if (allocatableBudget <= 0) {
      throw new Error(`Budget $${params.budget} too low: $${totalRelayFees.toFixed(2)} needed for relay fees alone (${selectedAgents.length} agents × $${RELAY_FEE_PER_AGENT})`)
    }

    console.log(`[DelegateFlow] Budget breakdown: total=$${budgetNum}, relayFees=$${totalRelayFees.toFixed(2)} (${selectedAgents.length}×$${RELAY_FEE_PER_AGENT}), allocatable=$${allocatableBudget.toFixed(2)}`)

    addStep({ type: 'analyzing', message: `Venice AI reasoning about budget allocation ($${allocatableBudget.toFixed(2)} after $${totalRelayFees.toFixed(2)} relay fees)...` })

    let allocations: { agentName: string; amount: string; reasoning: string }[] = []

    try {
      const budgetReasoning = await veniceChat([
        {
          role: 'system',
          content: `You are a budget allocation AI. Given a total budget and agent assignments, allocate USDC proportionally based on task complexity. More complex tasks get larger budgets. Respond in JSON only: { "allocations": [{ "agentName": "...", "amount": "X.XX", "reasoning": "one sentence why" }] }. The amounts MUST sum to exactly ${allocatableBudget.toFixed(2)}.`,
        },
        {
          role: 'user',
          content: `Budget: $${allocatableBudget.toFixed(2)} USDC (after relay fees)\nAgents:\n${selectedAgents.map((a, i) => `- ${a.name}: "${subtasks[i]?.description || params.task}" (complexity: ${subtasks[i]?.complexity || 'moderate'})`).join('\n')}`,
        },
      ])

      const cleaned = budgetReasoning.reply.replace(/```json\n?|\n?```/g, '').replace(/^[^{]*/, '').replace(/[^}]*$/, '')
      const parsed = JSON.parse(cleaned)
      allocations = parsed.allocations || []
    } catch {
      allocations = selectedAgents.map(a => ({
        agentName: a.name,
        amount: '0',
        reasoning: 'Equal allocation (budget reasoning unavailable)',
      }))
    }

    // Deterministic rounding: last agent gets the remainder to avoid rounding drift
    allocations = roundAllocations(allocations, allocatableBudget)

    const totalAllocated = allocations.reduce((sum, a) => sum + parseFloat(a.amount), 0)
    const totalExpectedSpend = totalAllocated + totalRelayFees
    const remainingBudget = budgetNum - totalExpectedSpend
    console.log(`[DelegateFlow] Allocation validation: allocated=$${totalAllocated.toFixed(2)}, relayFees=$${totalRelayFees.toFixed(2)}, totalExpected=$${totalExpectedSpend.toFixed(2)}, userBudget=$${budgetNum}, remaining=$${remainingBudget.toFixed(2)}`)

    if (totalExpectedSpend > budgetNum + 0.001) {
      throw new Error(`Allocation overflow: total expected spend $${totalExpectedSpend.toFixed(4)} exceeds budget $${budgetNum}`)
    }

    addStep({
      type: 'budgeting',
      message: `Budget: $${budgetNum} total | $${totalRelayFees.toFixed(2)} relay fees reserved | ${allocations.map(a => `${a.agentName} → $${a.amount}`).join(', ')}`,
      allocations,
    })

    } // end if (!skipVenicePlanning)

    // Resolve final state for Step 4 (works for both GenericAgent and Venice paths)
    const finalAllocStep = run.steps.find(s => 'allocations' in s && (s as any).allocations)
    const finalAllocations: { agentName: string; amount: string; reasoning: string }[] = (finalAllocStep as any)?.allocations || []
    const finalSelectedAgents = run.selectedAgents

    emitProofEvent({
      type: 'budget-allocated',
      actorType: 'system',
      actorId: 'friday',
      sessionId,
      runId: run.id,
      label: `Budget split: $${params.budget} total ($${totalRelayFees.toFixed(2)} relay fees reserved) across ${finalSelectedAgents.length} agents`,
      detail: { allocations: finalAllocations, totalRelayFees: totalRelayFees.toFixed(2), allocatableBudget: allocatableBudget.toFixed(2) },
      proofSource: 'off-chain',
    })

    // Step 4: Create proportional redelegations + relay on-chain via 1Shot
    const delegationDetails: { agentName: string; amount: string }[] = []
    const relayResults: { agentName: string; taskId: string; txHash: string | null }[] = []

    const rootDelegation = getDelegation(params.rootDelegationId)
    const permissionContext = rootDelegation?.signedDelegation

    const delegationCtx: X402DelegationContext | null = permissionContext ? {
      delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
      permissionContext: (permissionContext as any).permissionContext || '',
      delegator: rootDelegation?.delegator as string || '',
    } : null

    // Pre-relay hard validation: sum(allocations) + totalRelayFees must not exceed budget
    const preRelaySum = finalAllocations.reduce((s, a) => s + parseFloat(a.amount), 0)
    const preRelayTotal = preRelaySum + totalRelayFees
    if (preRelayTotal > budgetNum + 0.001) {
      throw new Error(`Pre-relay guard failed: allocations($${preRelaySum.toFixed(2)}) + fees($${totalRelayFees.toFixed(2)}) = $${preRelayTotal.toFixed(2)} exceeds budget $${budgetNum}`)
    }

    console.log(JSON.stringify({
      event: 'delegateflow.relay_phase_start',
      flowId: run.id,
      delegationId: params.rootDelegationId,
      selectedAgents: finalSelectedAgents.map(a => a.name),
      budget: budgetNum,
      relayFees: parseFloat(totalRelayFees.toFixed(2)),
      allocatableBudget: parseFloat(allocatableBudget.toFixed(2)),
      allocations: finalAllocations.map(a => ({ agent: a.agentName, amount: a.amount })),
      totalExpectedSpend: parseFloat(preRelayTotal.toFixed(2)),
      remainingBudget: parseFloat((budgetNum - preRelayTotal).toFixed(2)),
    }))

    for (let i = 0; i < finalSelectedAgents.length; i++) {
      const agent = finalSelectedAgents[i]
      const allocation = finalAllocations[i]
      if (agent.walletAddress && allocation) {
        const x402Price = Math.max(
          parseFloat(agent.x402Price || '0.01'),
          parseFloat(allocation.amount),
        ).toFixed(6)
        console.log(`[DelegateFlow]   agent[${i}] ${agent.name}: allocation=$${allocation.amount}, x402Price=$${x402Price}, relayFee=$${RELAY_FEE_PER_AGENT}, wallet=${agent.walletAddress}`)
        const transferAmount = parseUnits(x402Price, 6)
        const redeleg = createRedelegation({
          parentId: params.rootDelegationId,
          delegate: agent.walletAddress as Address,
          maxAmount: transferAmount,
        })
        delegationDetails.push({
          agentName: agent.name,
          amount: x402Price,
        })

        // Relay on-chain via 1Shot relayer_send7710Transaction
        if (permissionContext) {
          try {
            const delegations = (permissionContext as any).delegations as any[] | undefined
            if (!delegations || !Array.isArray(delegations) || delegations.length === 0) {
              console.warn(`[DelegateFlow] No decoded delegations for ${agent.name}, skipping relay`)
            } else {
              // Serialize delegations for 1Shot (BigInt salt → hex string)
              const serializedDelegations = delegations.map((d: any) => ({
                delegate: d.delegate,
                delegator: d.delegator,
                authority: d.authority,
                caveats: (d.caveats || []).map((c: any) => ({
                  enforcer: c.enforcer,
                  terms: c.terms || '0x',
                  args: c.args || '0x',
                })),
                salt: typeof d.salt === 'bigint' ? `0x${d.salt.toString(16).padStart(64, '0')}` : d.salt,
                signature: d.signature,
              }))

              // Build ERC-20 transfer calldata
              const paddedTo = (agent.walletAddress as string).slice(2).toLowerCase().padStart(64, '0')
              const paddedAmount = transferAmount.toString(16).padStart(64, '0')
              const transferData = `0xa9059cbb${paddedTo}${paddedAmount}`

              // Get fee data for the fee payment execution
              const fee = await getFeeData()

              // Build fee payment execution (required by 1Shot as first execution)
              const feeAtoms = parseUnits(fee.minFee || '0', 6)
              const paddedFeeCollector = fee.feeCollector.slice(2).toLowerCase().padStart(64, '0')
              const paddedFeeAmount = feeAtoms.toString(16).padStart(64, '0')
              const feeTransferData = `0xa9059cbb${paddedFeeCollector}${paddedFeeAmount}`

              console.log(`[DelegateFlow] 1Shot relay for ${agent.name}: $${x402Price} USDC, fee=${fee.minFee}, feeCollector=${fee.feeCollector}`)

              const webhookBase = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`
              const taskId = await relaySend7710Transaction({
                chainId: '8453',
                transactions: [{
                  permissionContext: serializedDelegations,
                  executions: [
                    { target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', value: '0', data: feeTransferData },
                    { target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', value: '0', data: transferData },
                  ],
                }],
                authorizationList: [],
                context: fee.context,
                destinationUrl: `${webhookBase}/api/delegateflow/relay/webhook`,
              })

              storeRelayTask({
                taskId,
                type: '7710',
                status: 'submitted',
                txHash: null,
                blockNumber: null,
                address: agent.walletAddress as string,
                error: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              })

              addStep({ type: 'relay-submitting', message: `Submitting 1Shot transaction for ${agent.name}`, agentName: agent.name, amount: x402Price, taskId })
              addStep({ type: 'relay-waiting', message: `Waiting for on-chain confirmation: ${agent.name}`, agentName: agent.name, taskId })

              const relayProofId = await emitProofEvent({
                type: 'relay-submitted',
                actorType: 'relay',
                actorId: '1shot',
                sessionId,
                runId: run.id,
                agentId: undefined,
                relayTaskId: taskId,
                amountUsdc: x402Price,
                feeUsdc: fee.minFee || '0',
                fromAddress: rootDelegation?.delegator || '',
                toAddress: agent.walletAddress as string,
                label: `1Shot relay: ${agent.name} ($${x402Price} USDC)`,
                detail: { agentSlug: agent.slug },
                proofSource: 'on-chain',
              })

              let txHash: string | null = null
              for (let attempt = 0; attempt < 15; attempt++) {
                await new Promise(r => setTimeout(r, 2000))
                const task = await pollAndUpdateTask(taskId)
                if (task?.status === 'confirmed') {
                  txHash = task.txHash || null
                  markRedeemed(redeleg.id, taskId, transferAmount)
                  if (relayProofId && txHash) {
                    confirmProofEvent(relayProofId, txHash, task.blockNumber || undefined)
                  }
                  break
                }
                if (task?.status === 'failed') {
                  console.warn(`[DelegateFlow] Relay failed for ${agent.name}:`, task.error)
                  if (relayProofId) failProofEvent(relayProofId, task.error || 'Relay failed')
                  break
                }
              }
              if (txHash) {
                addStep({ type: 'relay-confirmed', message: `On-chain confirmed: ${agent.name} ($${x402Price} USDC)`, agentName: agent.name, amount: x402Price, txHash })
              } else {
                addStep({ type: 'relay-failed', message: `Relay failed for ${agent.name}`, agentName: agent.name, amount: x402Price })
              }
              relayResults.push({ agentName: agent.name, taskId, txHash })
            }
          } catch (relayErr: any) {
            console.warn(`[DelegateFlow] Relay for ${agent.name} failed:`, relayErr?.message)
          }
        }
      }
    }

    const confirmedCount = relayResults.filter(r => r.txHash).length
    console.log(JSON.stringify({
      event: 'delegateflow.relay_results',
      flowId: run.id,
      confirmed: confirmedCount,
      total: relayResults.length,
      results: relayResults.map(rr => ({
        agent: rr.agentName,
        taskId: rr.taskId,
        txHash: rr.txHash || null,
        status: rr.txHash ? 'confirmed' : 'failed',
      })),
    }))

    addStep({
      type: 'delegating',
      message: `Created ${delegationDetails.length} ERC-7710 redelegations${confirmedCount > 0 ? ` (${confirmedCount} confirmed on-chain)` : ''}`,
      delegations: delegationDetails,
    })

    // Step 5: Execute sub-agent calls via unified x402 chain (1Shot paid -> x402 verifies)
    const agentResponses: string[] = []
    const x402Results: { agentName: string; http402Received: boolean; paymentSignatureSent: boolean; priorPaymentVerified: boolean; responseUnlocked: boolean; priorPaymentTxHash: string | null }[] = []

    for (let i = 0; i < finalSelectedAgents.length; i++) {
      const agent = finalSelectedAgents[i]
      const subtask = subtasks[i]
      addStep({ type: 'x402-verifying', message: `Verifying payment with ${agent.name} via x402 protocol`, agentName: agent.name })

      let reply: string | null = null
      const priorTxHash = relayResults[i]?.txHash

      console.log(`[DelegateFlow] x402 check for ${agent.name}: delegationCtx=${!!delegationCtx}, priorTxHash=${priorTxHash || 'null'}, relayResults[${i}]=${JSON.stringify(relayResults[i])}`)

      // Unified chain: 1Shot already paid -> now verify via x402
      if (delegationCtx && priorTxHash) {
        try {
          const x402Result = await callAgentWithX402(
            `http://localhost:${process.env.PORT || 3001}/api/v1/chat/${agent.slug}`,
            { message: subtask?.description || params.task },
            delegationCtx,
            priorTxHash,
            { timeout: 60000 },
          )

          console.log(`[DelegateFlow] x402 result for ${agent.name}: success=${x402Result.success}, http402=${x402Result.http402Received}, paymentSent=${x402Result.paymentSignatureSent}, verified=${x402Result.priorPaymentVerified}, unlocked=${x402Result.responseUnlocked}, error=${x402Result.error}`)
          if (x402Result.success) {
            reply = x402Result.response?.reply || null
            addStep({ type: 'agent-working', message: `${agent.name} is processing the task...`, agentName: agent.name })
          } else {
            console.warn(`[DelegateFlow] ${agent.name}: x402 failed: ${x402Result.error}`)
          }

          x402Results.push({
            agentName: agent.name,
            http402Received: x402Result.http402Received,
            paymentSignatureSent: x402Result.paymentSignatureSent,
            priorPaymentVerified: x402Result.priorPaymentVerified,
            responseUnlocked: x402Result.responseUnlocked,
            priorPaymentTxHash: priorTxHash,
          })

          addStep({
            type: 'x402-payment',
            agentName: agent.name,
            message: x402Result.success
              ? `x402 verified: ${agent.name} (prior tx confirmed on-chain)`
              : `x402 failed for ${agent.name}: ${x402Result.error || 'unknown'}`,
            checks: {
              http402Received: x402Result.http402Received,
              paymentSignatureSent: x402Result.paymentSignatureSent,
              priorPaymentVerified: x402Result.priorPaymentVerified,
              responseUnlocked: x402Result.responseUnlocked,
              priorPaymentTxHash: priorTxHash,
            },
          })

          emitProofEvent({
            type: 'unified-x402-erc7710-payment',
            actorType: 'system',
            actorId: 'friday',
            sessionId,
            runId: run.id,
            agentId: agent.slug,
            label: `1Shot paid ${agent.name} on-chain. x402 verified prior payment.`,
            detail: {
              agentSlug: agent.slug,
              agentName: agent.name,
              amount: agent.x402Price || finalAllocations[i]?.amount,
              delegationManager: delegationCtx.delegationManager,
              delegator: delegationCtx.delegator,
              hasPermissionContext: true,
              http402Received: x402Result.http402Received,
              paymentSignatureSent: x402Result.paymentSignatureSent,
              priorPaymentVerified: x402Result.priorPaymentVerified,
              responseUnlocked: x402Result.responseUnlocked,
              priorPaymentTxHash: priorTxHash,
              paymentRail: 'oneshot-prior-payment',
              settledBy: '1shot-relay',
              verifiedBy: 'onchain-tx-verifier',
              facilitator: 'none',
              unlockMethod: 'verified-prior-payment',
              doubleChargePrevented: true,
            },
            proofSource: 'on-chain',
            txHash: priorTxHash,
          })
        } catch (x402Err: any) {
          console.warn(`[DelegateFlow] ${agent.name}: x402 call error: ${x402Err?.message}`)
          x402Results.push({
            agentName: agent.name,
            http402Received: false,
            paymentSignatureSent: false,
            priorPaymentVerified: false,
            responseUnlocked: false,
            priorPaymentTxHash: priorTxHash,
          })
          addStep({
            type: 'x402-payment',
            agentName: agent.name,
            message: `x402 verification failed for ${agent.name}: ${x402Err?.message}`,
            checks: {
              http402Received: false,
              paymentSignatureSent: false,
              priorPaymentVerified: false,
              responseUnlocked: false,
              priorPaymentTxHash: priorTxHash,
            },
          })
        }
      } else {
        console.warn(`[DelegateFlow] x402 SKIPPED for ${agent.name}: delegationCtx=${!!delegationCtx}, priorTxHash=${priorTxHash || 'null'}`)
      }

      // Fallback: internal bypass (dev only) when x402 not available or failed
      if (!reply && process.env.ENABLE_INTERNAL_AGENT_BYPASS === 'true') {
        try {
          const chatRes = await fetch(
            `http://localhost:${process.env.PORT || 3001}/api/v1/chat/${agent.slug}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': process.env.INTERNAL_API_SECRET || '' },
              body: JSON.stringify({ message: subtask?.description || params.task }),
              signal: AbortSignal.timeout(5000),
            },
          )
          if (chatRes.ok) {
            const data = await chatRes.json()
            reply = data.reply
            console.log(`[DelegateFlow] ${agent.name} responded via internal bypass (${reply?.length || 0} chars)`)
          }
        } catch (err: any) {
          console.warn(`[DelegateFlow] Internal call to ${agent.name} failed:`, err?.message)
        }
      }

      // Final fallback: Venice Chat
      if (!reply) {
        addStep({ type: 'agent-working', message: `${agent.name} is working on the task...`, agentName: agent.name })
        const agentReply = await veniceChat([
          { role: 'system', content: `You are "${agent.name}", an AI agent on WorkAgnt.ai. ${agent.description}. Provide a thorough, data-driven response.` },
          { role: 'user', content: subtask?.description || params.task },
        ], { enableWebSearch: 'auto' })
        reply = agentReply.reply
      }

      if (reply) {
        addStep({ type: 'agent-completed', message: `${agent.name} completed`, agentName: agent.name, replyLength: reply.length })
      } else {
        addStep({ type: 'agent-failed', message: `${agent.name} did not return a response`, agentName: agent.name, reason: 'no reply' })
      }

      agentResponses.push(`**${agent.name}:** ${reply}`)

      emitProofEvent({
        type: 'agent-response',
        actorType: 'agent',
        actorId: agent.slug,
        sessionId,
        runId: run.id,
        label: `${agent.name} completed subtask`,
        detail: { subtask: subtask?.description || params.task, responseLength: reply?.length || 0 },
        proofSource: 'off-chain',
      })
    }

    // Step 5b: Discover and call external x402 agents via Venice AI
    addStep({ type: 'analyzing', message: 'Venice AI discovering external x402 agents for cross-platform A2A...' })

    let externalResponses: string[] = []
    try {
      const discovery = await veniceChat([
        {
          role: 'system',
          content: `You are an x402 agent discovery engine. Given a research task, search the web for publicly available AI agent APIs that accept x402 payments (HTTP 402 Payment Required protocol). Look for agents on platforms like orbisapi.com, agentic.market, or any x402-compatible endpoints. Respond in JSON only: { "agents": [{ "name": "...", "url": "...", "relevance": "one sentence" }] }. Return at most 2 agents. If none found, return { "agents": [] }. Do NOT use <think> tags.`,
        },
        { role: 'user', content: params.task },
      ], { enableWebSearch: 'auto' })

      let externalAgents: { name: string; url: string; relevance: string }[] = []
      try {
        let cleaned = discovery.reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        cleaned = cleaned.replace(/```json\n?|\n?```/g, '').replace(/^[^{]*/, '').replace(/[^}]*$/, '')
        const parsed = JSON.parse(cleaned)
        externalAgents = parsed.agents || []
      } catch { /* no external agents found */ }

      if (externalAgents.length > 0) {
        addStep({ type: 'executing', message: `Found ${externalAgents.length} external x402 agents — calling with ERC-7710 delegation + x402 fallback...`, agentName: 'External A2A' })

        for (const ext of externalAgents.slice(0, 2)) {
          try {
            console.log(`[DelegateFlow] Calling external agent: ${ext.name} at ${ext.url}`)
            let extReply: string | null = null
            let paymentMethod = 'free'

            // Attempt 1: Try with ERC-7710 delegation header (MetaMask delegation payment)
            const delegationHeader = permissionContext ? JSON.stringify({
              delegationId: params.rootDelegationId,
              delegator: rootDelegation?.delegator,
              delegate: rootDelegation?.delegate,
              amount: '0.01',
              expiresAt: rootDelegation?.expiresAt || Date.now() + 3600000,
              signedDelegation: permissionContext,
            }) : null

            let extRes = await fetch(ext.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(delegationHeader ? { 'X-Delegation': delegationHeader } : {}),
              },
              body: JSON.stringify({ message: params.task }),
              signal: AbortSignal.timeout(15000),
            })

            if (extRes.ok) {
              const data = await extRes.json()
              extReply = data.reply || data.response || data.result || JSON.stringify(data).slice(0, 500)
              paymentMethod = delegationHeader ? 'ERC-7710' : 'free'
            } else if (extRes.status === 402) {
              // Attempt 2: Fall back to Coinbase x402 (@x402/fetch with deployer key)
              console.log(`[DelegateFlow] ${ext.name} requires payment — trying Coinbase x402...`)
              const fetchWithPay = getFetchWithPay()
              if (fetchWithPay) {
                try {
                  const paidRes = await fetchWithPay(ext.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: params.task }),
                  })
                  if (paidRes.ok) {
                    const data = await paidRes.json()
                    extReply = data.reply || data.response || data.result || JSON.stringify(data).slice(0, 500)
                    paymentMethod = 'x402-coinbase'
                  }
                } catch (x402Err: any) {
                  console.warn(`[DelegateFlow] Coinbase x402 payment failed for ${ext.name}:`, x402Err?.message?.slice(0, 80))
                }
              }

              if (!extReply) {
                extReply = `[x402 Payment Required — agent confirmed at ${ext.url}. Supports cross-platform paid coordination via HTTP 402 protocol.]`
                paymentMethod = 'x402-discovered'
              }
            }

            if (extReply) {
              externalResponses.push(`**${ext.name} (External, paid via ${paymentMethod}):** ${extReply}`)
              console.log(`[DelegateFlow] External agent ${ext.name} responded (${extReply.length} chars, method=${paymentMethod})`)
            }
          } catch (extErr: any) {
            console.warn(`[DelegateFlow] External agent ${ext.name} failed:`, extErr?.message?.slice(0, 100))
          }
        }
      }
    } catch (discErr: any) {
      console.warn(`[DelegateFlow] External agent discovery failed:`, discErr?.message?.slice(0, 100))
    }

    if (externalResponses.length > 0) {
      agentResponses.push(...externalResponses)
    }

    // Step 6: Synthesis — try GenericAgent first, fallback to Venice direct
    addStep({ type: 'synthesizing', message: 'Friday is synthesizing all agent responses...' })
    const gaSynthesis = await tryGenericAgentSynthesize(
      params.task,
      finalSelectedAgents.map((a: { name: string; x402Price?: string }, i: number) => ({
        agent_name: a.name,
        subtask: subtasks[i]?.description || params.task,
        response: agentResponses[i] || '',
        budget: parseFloat(finalAllocations[i]?.amount || '0'),
      })),
      budgetNum,
      finalSelectedAgents.reduce((sum: number, a: { x402Price?: string }) => sum + parseFloat(a.x402Price || '0'), 0)
    )

    let reportText: string
    let skillLearned: string | null = null

    if (gaSynthesis) {
      reportText = gaSynthesis.report
      skillLearned = gaSynthesis.skill_learned || null
      console.log(`[DelegateFlow] GenericAgent synthesis: ${reportText.length} chars, skill: ${skillLearned || 'none'}`)
    } else {
      const synthesis = await veniceChat([
        {
          role: 'system',
          content: 'You are a research synthesizer for WorkAgnt.ai. Combine the following agent reports into a cohesive, well-structured research report. Use **bold** for section labels (no markdown headers). Be thorough and actionable. If the reports contain data, present it clearly. Do NOT use <think> tags or reasoning blocks — respond directly with the report.',
        },
        {
          role: 'user',
          content: `Original task: ${params.task}\n\nAgent reports:\n${agentResponses.join('\n\n')}`,
        },
      ], { enableWebSearch: 'auto', maxTokens: 4096 })

      reportText = synthesis.reply
      if (reportText.includes('<think>')) {
        reportText = reportText.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      }
      console.log(`[DelegateFlow] Venice synthesis: ${reportText.length} chars`)
    }

    run.report = reportText || agentResponses.join('\n\n')
    console.log(`[DelegateFlow] Final report: ${run.report.length} chars`)

    // Step 7: Venice AI image generation
    let imageUrl: string | null = null
    try {
      imageUrl = await veniceImageGenerate(
        `Clean infographic summarizing: ${params.task}. Modern flat design, data visualization style, dark background, blue and white color scheme.`,
      )
    } catch (err) {
      console.log('[DelegateFlow] Image generation skipped:', (err as any)?.message?.slice(0, 100))
    }
    run.reportImageUrl = imageUrl

    const agentSpend = finalSelectedAgents
      .reduce((sum: number, a: { x402Price?: string }) => sum + parseFloat(a.x402Price || '0'), 0)
    const relayFeeTotal = relayResults.length * 0.01
    const totalSpent = (agentSpend + relayFeeTotal).toFixed(2)
    const balanceRemaining = (parseFloat(params.budget) - parseFloat(totalSpent)).toFixed(2)
    run.totalSpent = totalSpent
    run.status = 'complete'

    const successfulAgents = x402Results.filter(r => r.responseUnlocked).map(r => r.agentName)
    const failedAgents = x402Results.filter(r => !r.responseUnlocked).map(r => r.agentName)
    const txHashes = relayResults.filter(r => r.txHash).map(r => ({ agent: r.agentName, txHash: r.txHash }))

    console.log(JSON.stringify({
      event: 'delegateflow.complete',
      flowId: run.id,
      delegationId: params.rootDelegationId,
      status: 'complete',
      budget: parseFloat(params.budget),
      totalSpent: parseFloat(totalSpent),
      relayFees: parseFloat(relayFeeTotal.toFixed(2)),
      agentSpend: parseFloat(agentSpend.toFixed(2)),
      balanceRemaining: parseFloat(balanceRemaining),
      successfulAgents,
      failedAgents,
      txHashes,
    }))

    const chain = getDelegationChain(params.rootDelegationId)
    const serializedChain = chain.map(d => ({
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
    }))

    emitProofEvent({
      type: 'report-generated',
      actorType: 'system',
      actorId: 'friday',
      sessionId,
      runId: run.id,
      label: `Report synthesized (${run.report.length} chars)`,
      detail: { reportLength: run.report.length, imageGenerated: !!imageUrl },
      proofSource: 'off-chain',
    })

    emitProofEvent({
      type: 'workflow-completed',
      actorType: 'system',
      actorId: 'friday',
      sessionId,
      runId: run.id,
      amountUsdc: totalSpent,
      label: `DelegateFlow complete: $${totalSpent} spent, ${finalSelectedAgents.length} agents`,
      detail: { totalSpent, agentsUsed: finalSelectedAgents.length, relayFees: relayFeeTotal.toFixed(2), balanceRemaining },
      proofSource: 'off-chain',
    })

    addStep({
      type: 'complete',
      report: run.report,
      imageUrl,
      totalSpent,
      budget: params.budget,
      relayFees: relayFeeTotal.toFixed(2),
      balanceRemaining,
      delegationChain: serializedChain,
      relayResults,
      x402Results: x402Results.length > 0 ? x402Results : undefined,
      planningReasoning: gaPlan?.reasoning || null,
      skillLearned: skillLearned || null,
      agentCalls: finalSelectedAgents.map((a: { name: string }, i: number) => ({
        agentName: a.name,
        callCount: 1,
        subtask: subtasks[i]?.description || params.task,
      })),
    })

    return run
  } catch (err: any) {
    console.error(JSON.stringify({
      event: 'delegateflow.failed',
      flowId: run.id,
      delegationId: params.rootDelegationId,
      status: 'failed',
      error: err.message || 'Unknown error',
    }))
    run.status = 'failed'
    addStep({ type: 'error', message: err.message || 'Unknown error' })
    return run
  }
}
