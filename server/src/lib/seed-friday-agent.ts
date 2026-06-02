import { db } from '../db'
import { agents, users } from '../db/schema'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'

const FRIDAY_SLUG = 'friday'

export async function seedFridayAgent() {
  const existing = await db.select().from(agents).where(eq(agents.slug, FRIDAY_SLUG)).limit(1)
  if (existing.length > 0) {
    console.log('[Seed] Friday agent already exists')
    return existing[0]
  }

  let systemUser = await db.select().from(users).where(eq(users.privyId, 'system-platform')).limit(1)
  if (systemUser.length === 0) {
    const userId = randomUUID()
    await db.insert(users).values({
      id: userId,
      privyId: 'system-platform',
      walletAddress: process.env.ORCHESTRATOR_WALLET || '0xA702Fb74B88A5199F9011eca0c9Bee38984A9Abb',
      name: 'WorkAgnt',
      email: 'system@workagnt.ai',
      credits: 999999,
      role: 'admin',
      verified: true,
    })
    systemUser = await db.select().from(users).where(eq(users.privyId, 'system-platform')).limit(1)
  }

  const agentId = randomUUID()
  await db.insert(agents).values({
    id: agentId,
    userId: systemUser[0].id,
    name: 'Friday',
    slug: FRIDAY_SLUG,
    category: 'orchestrator',
    agentMode: 'delegateflow',
    description: 'Your AI hiring manager. Give Friday a task and budget — she hires specialist AI agents, pays them on-chain via your MetaMask Smart Account (ERC-7710), and delivers a synthesized report. Powered by GenericAgent framework on Venice AI.',
    systemPrompt: 'You are Friday, an AI hiring manager that coordinates other AI agents to complete complex tasks. You decompose tasks, select specialists, allocate budgets, and synthesize results.',
    greeting: "I'm Friday, your AI hiring manager. Connect your MetaMask Smart Account, set a budget, and I'll coordinate a team of AI agents to complete your task — paying each one on-chain.",
    x402Enabled: true,
    x402PriceUsdc: '0.10',
    agentWalletAddress: process.env.ORCHESTRATOR_WALLET || '0xA702Fb74B88A5199F9011eca0c9Bee38984A9Abb',
    walletEnabled: true,
    isPublished: true,
    isActive: true,
    primaryColor: '#8b5cf6',
  })

  console.log(`[Seed] Friday agent created: ${agentId}`)
  return { id: agentId, slug: FRIDAY_SLUG }
}
