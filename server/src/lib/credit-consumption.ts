const LOW_CREDIT_THRESHOLD = 200

export async function consumeCredits(
  userId: string,
  agentId: string,
  cost: number
): Promise<{ success: boolean; newBalance: number; lowCredit: boolean }> {
  if (cost <= 0) return { success: true, newBalance: -1, lowCredit: false }

  const { db, schema } = await import('../db/index.js')
  const { eq, sql } = await import('drizzle-orm')

  return await db.transaction(async (tx: any) => {
    const result = await tx.execute(
      sql`SELECT credits FROM users WHERE id = ${userId} FOR UPDATE`
    )
    const rows = (result as any).rows ?? result
    const user = Array.isArray(rows) ? rows[0] : rows
    const currentCredits = (user as any)?.credits ?? 0

    if (currentCredits < cost) {
      return { success: false, newBalance: currentCredits, lowCredit: currentCredits <= LOW_CREDIT_THRESHOLD }
    }

    const newBalance = currentCredits - cost

    await tx.update(schema.users)
      .set({ credits: sql`${schema.users.credits} - ${cost}` })
      .where(eq(schema.users.id, userId))

    await tx.insert(schema.creditTransactions).values({
      userId,
      amount: -cost,
      type: 'consumption',
      description: `AI chat (${cost} credits / ~${cost * 1000} tokens)`,
      agentId,
    })

    // Log low-credit warning when balance drops below threshold
    if (newBalance <= LOW_CREDIT_THRESHOLD && currentCredits > LOW_CREDIT_THRESHOLD) {
      await tx.insert(schema.creditTransactions).values({
        userId,
        amount: 0,
        type: 'consumption',
        description: `LOW CREDIT WARNING: Balance dropped to ${newBalance}. Buy more credits or stake $AGNT.`,
        agentId,
      })
    }

    return { success: true, newBalance, lowCredit: newBalance <= LOW_CREDIT_THRESHOLD }
  })
}
