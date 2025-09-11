# @hazbase/kit
[![npm version](https://badge.fury.io/js/@hazbase%2Fkit.svg)](https://badge.fury.io/js/@hazbase%2Fkit)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## Overview
`@hazbase/kit` is an **SDK that wraps pre‑designed smart contracts for safe Web (TypeScript) access**.  
For each domain (issuance, KPI, whitelist, emergency pause, etc.) it provides **typed Helpers** that unify **reads/writes, snapshots, and event handling** over **ethers v6**. Use the same code in **browsers or Node.js**.

- Typical helpers: `FlexibleTokenHelper`, `BondTokenHelper`, `KpiRegistryHelper`, `EmergencyPauseManagerHelper`, `WhitelistHelper`, …
- Design: **ESM‑first**, **ethers v6**, BigInt‑friendly types, minimal runtime assumptions
- Goal: Let frontends and backends **safely connect and operate** contracts using a consistent TypeScript API

---

## Requirements
- Node.js **>= 18.18** (ESM, fetch, BigInt)
- TypeScript **>= 5.2**
- Ethers **v6**
- Module format: **ESM** (CommonJS‑only builds are discouraged)

**`package.json` (example)**
```jsonc
{
  "type": "module",
  "engines": { "node": ">=18.18" }
}
```

**`tsconfig.json` (example)**
```jsonc
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM"],
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "types": ["node"]
  }
}
```

---

## Installation
```bash
pnpm add @hazbase/kit ethers dotenv
# or
npm i @hazbase/kit ethers dotenv
```

---

## Environment (.env example)
```
RPC_URL=https://<your-rpc>
PRIVATE_KEY=0x<private-key>      # server-side only
FLEXIBLE_TOKEN_ADDRESS=0x...     # attach to an existing deployment (optional)
```

---

## Quick start: FlexibleToken **deploy → mint/issue → transfer**

**`scripts/flexible-token.ts`**
```ts
// FlexibleToken end-to-end: deploy -> mint -> transfer
import 'dotenv/config';
import { ethers } from 'ethers';
import { FlexibleTokenHelper } from '@hazbase/kit'; // Main exports

async function main() {
  // 1) Provider / Signer
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
  const signer   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  // 2) Deploy via Factory (clone deployment)
  //    NOTE: args order/name can differ depending on your implementation
  const chainId   = Number((await provider.getNetwork()).chainId);
  const name      = 'My Flexible Token';
  const symbol    = 'MFT';
  const decimals  = 18;
  const admin     = await signer.getAddress();

  const {address: tokenAddress} = await FlexibleTokenHelper.deploy(
    {
      name,
      symbol,
      treasury: signer.address,
      initialSupply: 0n,
      cap: ethers.parseUnits("1000000000", 6), // 1 B max
      decimals,
      transferable: true,
      admin: signer.address,
      forwarders: []
    },
    deployer  // deploy signer (owner)
  );

  console.log('Deployed FlexibleToken at:', tokenAddress);

  // 3) Attach helper
  const token = await FlexibleTokenHelper.attach(tokenAddress, signer);

  // Sanity reads
  console.log('symbol =', await token.symbol());
  console.log('decimals =', await token.decimals());

  // 4) Mint/Issue to self (requires proper role)
  const recipient = admin;
  const amount    = 1_000n * 10n ** 18n;

  const txMint = await token.mint(recipient, amount); // or token.issue(...)
  const rcMint = await txMint.wait();
  console.log('Minted:', amount.toString(), 'tx:', rcMint?.hash);

  console.log('balance(recipient) =', (await token.balanceOf(recipient)).toString());

  // 5) Transfer to another address
  const to       = '0x0123456789abcdef0123456789abcdef01234567';
  const sendAmt  = 100n * 10n ** 18n;

  const tx = await token.transfer(to, sendAmt);
  const rc = await tx.wait();
  console.log('Transferred:', sendAmt.toString(), 'to:', to, 'tx:', rc?.hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Run**
```bash
tsx scripts/flexible-token.ts
# or: node --env-file=.env --loader tsx scripts/flexible-token.ts
```

> If you already have a deployment, set `FLEXIBLE_TOKEN_ADDRESS` and do `FlexibleTokenHelper.attach(FLEXIBLE_TOKEN_ADDRESS, signer)` instead of deploying.

---

## Common operations (snippets)

### 1) Attach → read → write
```ts
// Attach, read, write (FlexibleToken)
const token = await FlexibleTokenHelper.attach(process.env.FLEXIBLE_TOKEN_ADDRESS!, signer);

// Reads
console.log('name =', await token.name());
console.log('totalSupply =', (await token.totalSupply()).toString());

// Writes (roles/pauses may apply)
await (await token.transfer('0xRecipient...', 1_000n)).wait();
```

### 2) Subscribe to events & fetch historical logs
```ts
// Live subscription (ERC-20 style Transfer)
token.contract.on('Transfer', (from, to, value, ev) => {
  console.log('Transfer:', { from, to, value: value.toString(), tx: ev.log.transactionHash });
});

// Historical logs
const event  = token.contract.interface.getEvent('Transfer');
const topic0 = token.contract.interface.getEventTopic(event);
const logs = await token.contract.runner!.provider!.getLogs({
  address: token.address,
  topics: [topic0],         // add indexed filters as needed
  fromBlock: 0x0,
  toBlock: 'latest',
});
for (const l of logs) {
  const parsed = token.contract.interface.parseLog(l);
  console.log('past Transfer:', parsed.args);
}
```

---

## Helper names

- **FlexibleTokenHelper** (used above)
- **BondTokenHelper**
- **ReservePoolHelper**
- **AgreementManagerHelper**
- **MarketManagerHelper**
- **WhitelistHelper**
- **KpiRegistryHelper**
- **PrivilegeNFTHelper / PrivilegeEditionHelper**
- **DebtManagerHelper**
- **EmergencyPauseManagerHelper**
- **TimelockControllerHelper**
- **GenericGovernorHelper / MetaGovernorHelper**
- **MultiTrustCredentialHelper**
- **SplitterHelper**
- **StakingHelper**

---

## Operations (roles & pause)
- **Least privilege**: hand off `DEFAULT_ADMIN_ROLE` to a Timelock/Multisig. Split `MINTER_ROLE`, `PAUSER_ROLE`, etc.
- **Pause/resume**: define a clear runbook for `pause`/`unpause` (monitoring signals, approval steps) and call through helpers.

---

## Troubleshooting (FAQ)
- **`INSUFFICIENT_ROLE` / `AccessControl:`** — missing role. Check minter/transfer permissions.
- **`paused` / `whenNotPaused`** — contract paused. Follow your governance recovery flow.
- **`insufficient funds`** — not enough gas. Fund the EOA or ensure relayer quota.
- **ESM/CJS mismatch** — kit is ESM‑first. If you’re on webpack4/CJS‑only, upgrade to Vite/webpack5 or enable ESM builds.

---

## Next steps
- See each helper’s **detailed page** (`FlexibleTokenHelper`, `BondTokenHelper`, `KpiRegistryHelper`, …) for full signatures, revert reasons, and recipes.
- Implement **event aggregation / snapshots** in your dashboard/backend for robust **disclosure & audit**.

---

## License
Apache-2.0
