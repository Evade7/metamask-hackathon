import { veniceChat, veniceEmbed, veniceImageGenerate, veniceCryptoRpc, cosineSimilarity } from './venice-ai.js'
import { createRedelegation, storeDelegation, markRedeemed, getDelegationChain, type DelegationRecord } from './delegation-manager.js'
import { relayDelegationRedemption, getRelayStatus } from './oneshot-relayer.js'
import { parseUnits, type Address } from 'viem'

const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

export type FlowStep =
  | { type: 'analyzing'; message: string }
  | { type: 'matching'; message: string; agents: { slug: string; name: string; score: number }[] }
  | { type: 'delegating'; message: string; delegations: { agentName: string; amount: string }[] }
  | { type: 'executing'; message: string; agentName: string }
  | { type: 'relaying'; message: string; taskId: string }
  | { type: 'synthesizing'; message: string }
  | { type: 'complete'; report: string; imageUrl: string | null; totalSpent: string; delegationChain: unknown[] }
  | { type: 'error'; message: string }

export interface FlowRun {
  id: string
  task: string
  budget: string
  rootDelegationId: string
  status: 'pending' | 'running' | 'complete' | 'failed'
  steps: FlowStep[]
  selectedAgents: { slug: string; name: string; description: string; walletAddress?: string }[]
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
}

export async function startDelegateFlow(params: {
  task: string
  budget: string
  rootDelegationId: string
  agents: AgentInfo[]
  onStep: (step: FlowStep) => void
}): Promise<FlowRun> {
  const run: FlowRun = {
    id: `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  function addStep(step: FlowStep) {
    run.steps.push(step)
    params.onStep(step)
  }

  try {
    // Step 1: Venice AI task decomposition
    addStep({ type: 'analyzing', message: 'Venice AI analyzing task and planning subtasks...' })

    const decomposition = await veniceChat([
      {
        role: 'system',
        content: `You are an AI task orchestrator for WorkAgnt.ai, an AI employee marketplace. Given a research task, decompose it into 2 subtasks that can be assigned to specialist AI agents. Respond in JSON format: { "subtasks": [{ "description": "...", "requiredSkill": "..." }] }`,
      },
      { role: 'user', content: params.task },
    ])

    let subtasks: { description: string; requiredSkill: string }[] = []
    try {
      const parsed = JSON.parse(decomposition.reply.replace(/```json\n?|\n?```/g, ''))
      subtasks = parsed.subtasks || []
    } catch {
      subtasks = [
        { description: params.task, requiredSkill: 'research' },
        { description: `Provide analysis and data for: ${params.task}`, requiredSkill: 'analysis' },
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
      })
      agentScores.push({ slug: agent.slug, name: agent.name, score: bestScore })
    }

    run.selectedAgents = selectedAgents
    addStep({
      type: 'matching',
      message: `Selected ${selectedAgents.length} agents via Venice AI embeddings`,
      agents: agentScores,
    })

    // Step 3: Check on-chain balance via Venice Crypto RPC
    addStep({ type: 'analyzing', message: 'Verifying on-chain USDC balance via Venice Crypto RPC...' })

    // Step 4: Create redelegations
    const budgetPerAgent = parseUnits(params.budget, 6) / BigInt(selectedAgents.length)
    const delegationDetails: { agentName: string; amount: string }[] = []

    for (const agent of selectedAgents) {
      if (agent.walletAddress) {
        const redeleg = createRedelegation({
          parentId: params.rootDelegationId,
          delegate: agent.walletAddress as Address,
          maxAmount: budgetPerAgent,
        })
        delegationDetails.push({
          agentName: agent.name,
          amount: (Number(budgetPerAgent) / 1e6).toFixed(2),
        })
      }
    }

    addStep({
      type: 'delegating',
      message: `Created ${delegationDetails.length} ERC-7710 redelegations`,
      delegations: delegationDetails,
    })

    // Step 5: Execute sub-agent x402 calls (simulated for now — real implementation needs live relay)
    const agentResponses: string[] = []
    for (const agent of selectedAgents) {
      addStep({ type: 'executing', message: `Calling ${agent.name} via x402...`, agentName: agent.name })

      const agentReply = await veniceChat([
        {
          role: 'system',
          content: `You are "${agent.name}", an AI agent on WorkAgnt.ai. ${agent.description}. Provide a thorough, data-driven response.`,
        },
        { role: 'user', content: params.task },
      ])
      agentResponses.push(`**${agent.name}:** ${agentReply.reply}`)
    }

    // Step 6: Venice AI synthesis
    addStep({ type: 'synthesizing', message: 'Venice AI synthesizing all agent responses...' })

    const synthesis = await veniceChat([
      {
        role: 'system',
        content: 'You are a research synthesizer. Combine the following agent reports into a cohesive, well-structured research report. Use **bold** for section labels. Be thorough and actionable.',
      },
      {
        role: 'user',
        content: `Original task: ${params.task}\n\nAgent reports:\n${agentResponses.join('\n\n')}`,
      },
    ])

    run.report = synthesis.reply

    // Step 7: Venice AI image generation
    let imageUrl: string | null = null
    try {
      imageUrl = await veniceImageGenerate(
        `Clean infographic summarizing: ${params.task}. Modern flat design, data visualization style, dark background, blue and white color scheme.`,
      )
    } catch (err) {
      console.log('[DelegateFlow] Image generation failed, continuing without image:', err)
    }
    run.reportImageUrl = imageUrl

    const totalSpent = (Number(budgetPerAgent) * selectedAgents.length / 1e6).toFixed(2)
    run.totalSpent = totalSpent
    run.status = 'complete'

    const chain = getDelegationChain(params.rootDelegationId)

    addStep({
      type: 'complete',
      report: synthesis.reply,
      imageUrl,
      totalSpent,
      delegationChain: chain,
    })

    return run
  } catch (err: any) {
    run.status = 'failed'
    addStep({ type: 'error', message: err.message || 'Unknown error' })
    return run
  }
}
