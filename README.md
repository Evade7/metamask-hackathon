# WorkAgnt x MetaMask Hackathon — DelegateFlow

**Live demo:** [workagnt.ai/delegate](https://workagnt.ai/delegate)

WorkAgnt.ai is a production AI employee marketplace on Base with 84+ live agents, x402 payments, and autonomous spending. This hackathon extends WorkAgnt with **MetaMask Smart Accounts**, **ERC-7710 delegation**, **1Shot gasless relay**, and **Venice AI intelligence**.

## What It Does

A user delegates scoped USDC spending permission to an orchestrator AI agent via ERC-7710. The orchestrator autonomously hires specialist sub-agents, pays them via x402 micropayments, and delivers a synthesized research report — all gasless, all on-chain, all verifiable.

**Flow:**
1. User connects wallet and upgrades to Smart Account (EIP-7702)
2. User creates ERC-7710 delegation: USDC, amount-capped, time-limited
3. Venice AI decomposes the task into subtasks
4. Venice AI embeddings match subtasks to the best agents from 84+ live agents
5. Orchestrator creates ERC-7710 **redelegations** to selected sub-agents
6. Sub-agents redeem delegations via 1Shot relay (gasless, USDC gas)
7. Sub-agents execute x402 calls and return results
8. Venice AI synthesizes all responses + generates a visual summary
9. Full delegation chain is verifiable on BaseScan

## Track Qualification

| Track | How We Qualify |
|---|---|
| **Best x402 + ERC-7710** ($3K) | MetaMask Smart Accounts do x402 calls using ERC-7710 delegations |
| **Best Agent** ($3K) | Full AI employee lifecycle with MetaMask Smart Account integration |
| **Best A2A Coordination** ($3K) | Orchestrator redelegates to sub-agents (ERC-7710 chaining) |
| **Best Use of Venice AI** ($3K) | 4 Venice endpoints: Chat, Embeddings, Image Gen, Crypto RPC |
| **Best Use of 1Shot Relayer** ($1K) | All delegation redemptions relayed gaslessly via 1Shot |

## Architecture

```
User (MetaMask Smart Account)
  |
  |-- ERC-7710 Delegation ($5 USDC, 1hr expiry)
  |
  v
Orchestrator Agent (Venice AI brain)
  |
  |-- Venice Chat: task decomposition
  |-- Venice Embeddings: agent matching (cosine similarity)
  |
  |-- Redelegation --> Sub-Agent A ($2.50)
  |     |-- 1Shot Relay (gasless)
  |     |-- x402 Payment --> Agent endpoint
  |
  |-- Redelegation --> Sub-Agent B ($2.50)
  |     |-- 1Shot Relay (gasless)
  |     |-- x402 Payment --> Agent endpoint
  |
  |-- Venice Chat: synthesize responses
  |-- Venice Image: generate visual summary
  |
  v
Final Report + Delegation Chain Receipts
```

## Hybrid Trust Model

WorkAgnt supports **both** trust models simultaneously:

| | PolicyGuard (existing) | ERC-7710 Delegation (hackathon) |
|---|---|---|
| Who controls spending? | Server (CDP executor) | On-chain (delegation caveats) |
| Trust model | Platform-enforced | User-enforced |
| Gas payment | CDP paymaster | 1Shot (USDC gas) |
| Best for | Platform-managed agents | User-delegated agents |

## File Structure

```
server/
  src/
    lib/
      venice-ai.ts              # Venice AI client — 4 endpoints
      delegation-manager.ts     # ERC-7710 create/redelegate/redeem/revoke
      oneshot-relayer.ts        # 1Shot relay integration (JSON-RPC)
      delegateflow-orchestrator.ts  # Main flow: decompose -> match -> delegate -> execute -> synthesize
    routes/
      delegateflow.ts           # Express API routes for /api/delegateflow/*

app/
  src/
    pages/
      DelegateFlowPage.tsx      # Full demo UI — wallet, task, progress, chain viz, report
    hooks/
      useSmartAccount.ts        # MetaMask EIP-7702 smart account upgrade
      useDelegation.ts          # ERC-7710 delegation creation + redelegation
```

## Tech Stack

- **MetaMask Delegation Toolkit** (`@metamask/delegation-toolkit`) — Smart Account upgrade + ERC-7710
- **Venice AI** — Chat (qwen3-6-27b), Embeddings (text-embedding-3-large), Image (flux-dev), Crypto RPC
- **1Shot Relayer** — Permissionless gasless relay at `relayer.1shotapi.com`
- **x402 Protocol** — HTTP 402 micropayments in USDC on Base
- **Base Mainnet** — Chain ID 8453, USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## Integration with Production

These files are extracted from the production [workagnt.ai](https://workagnt.ai) codebase. The hackathon code is additive — zero changes to existing agent infrastructure, x402 middleware, PolicyGuard, or CDP SmartAccounts.

## Team

Built by the WorkAgnt team — [workagnt.ai](https://workagnt.ai)
