/* ------------------------------------------------------------------ */
/*  ReservePoolHelper — Developer-friendly wrapper for ReservePool    */
/* ------------------------------------------------------------------ */
/*  Overview
    - Mirrors ReservePool.sol (UUPS + ERC2771 + RolesCommon + Pausable).
    - Exposes typed, ergonomic helpers for common flows:
        * deploy (proxy via factory), attach, connect
        * fundLiquidity / fundCompensation (ERC20 & native ETH)
        * triggerBuyBack (router-agnostic path)
        * payCompensation, sweep (between buckets)
        * pause / unpause, setBuyBackCooldown
        * views: liquidityOf, compensationOf, lastBuyBackAt, buyBackCooldown,
                 router, protocolToken
        * event queries: LiquidityFunded, CompensationFunded, BuyBackExecuted,
                         CompensationPaid, Sweep, BuyBackCooldownUpdated*/
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  TransactionReceipt,
} from "ethers";
import type { InterfaceAbi } from "ethers";

import { ReservePool } from "../contracts/ReservePool"; // ↺ ABI bundle (TypeChain/abi-exporter)
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                             Types                                   */
/* ------------------------------------------------------------------ */

/** Canonical 20-byte address string. */
export type Address = string;

/** Result of deployment via factory. */
export interface DeployResult {
  address : Address;                    // Proxy address
  receipt : TransactionReceipt;         // Deployment/initialize tx receipt
  helper  : ReservePoolHelper;          // Connected helper
}

/** Deploy-time arguments mapped to ReservePool.initialize(...) */
export interface DeployArgs {
  admin           : Address;            // ADMIN_ROLE holder
  router          : Address;            // AMM router (UniswapV2-like)
  protocolToken   : Address;            // Token to be bought back (path last)
  forwarders      : readonly Address[]; // ERC-2771 trusted forwarders
}

/** Minimal ERC20 interface (approve/allowance/decimals). */
const ERC20_ABI: InterfaceAbi = [
  "function approve(address spender, uint256 value) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function balanceOf(address account) external view returns (uint256)",
  "function symbol() external view returns (string)",
];

/* ------------------------------------------------------------------ */
/*                           Constants                                 */
/* ------------------------------------------------------------------ */

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
const MAX_UINT  = (2n ** 256n - 1n);

/* ------------------------------------------------------------------ */
/*                            Events                                   */
/* ------------------------------------------------------------------ */
/* Event signatures (for queryFilter convenience). Match .sol exactly. */
const EVT = {
  LiquidityFunded        : "LiquidityFunded(address,uint256)",
  CompensationFunded     : "CompensationFunded(address,uint256)",
  BuyBackExecuted        : "BuyBackExecuted(address,uint256,uint256,uint256)",
  CompensationPaid       : "CompensationPaid(address,address,uint256)",
  Sweep                  : "Sweep(address,uint256,bool)",
  BuyBackCooldownUpdated : "BuyBackCooldownUpdated(uint256)",
} as const;

/* ------------------------------------------------------------------ */
/*                             Helper                                  */
/* ------------------------------------------------------------------ */

export class ReservePoolHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner) {
    this.address  = address;
    this.runner   = runner;
    this.contract = new ethers.Contract(address, ReservePool.abi as InterfaceAbi, runner);
  }

  /* ================================================================ */
  /* 1) Factory Deploy / Attach / Connect                             */
  /* ================================================================ */

  /** Attach an existing ReservePool at `address`. */
  static attach(address: Address, runner: ContractRunner): ReservePoolHelper {
    return new ReservePoolHelper(address, runner);
  }

  /** Return a new helper bound to a different signer/runner. */
  connect(runner: ContractRunner | ethers.Signer): ReservePoolHelper {
    if (runner === this.runner) return this;
    return new ReservePoolHelper(this.address, runner);
  }

  /** Deploy a new ReservePool proxy via your factory helper.
   *  - The underlying implementation will be initialized with:
   *      initialize(admin, router, protocolToken, forwarders)
   */
  static async deploy(
    args: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions,
      "contractType" | "implABI" | "initArgs" | "signer">>
  ): Promise<DeployResult> {
    const { admin, router, protocolToken, forwarders } = args;
    const res = await deployViaFactory({
      contractType : ReservePool.contractType,  // e.g., "ReservePool"
      implABI      : ReservePool.abi,
      initArgs     : [admin, router, protocolToken, forwarders],
      signer,
      ...(opts ?? {}),
    });
    const helper = new ReservePoolHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /* ================================================================ */
  /* 2) Write: Reserve Funding                                        */
  /* ================================================================ */

  /** Fund the **liquidity** bucket for `token` by `amount`.
   *  - If `token == 0x0`, sends native ETH with `value = amount`.
   *  - If ERC20, performs `approveIfNeeded(token, this.address, amount)` and calls `fundLiquidity`.
   *  @returns Transaction receipt. Emits `LiquidityFunded`.
   */
  async fundLiquidity(
    token : Address,
    amount: bigint,
  ): Promise<TransactionReceipt> {
    if (token === ZERO_ADDR) {
      const tx = await this.contract.fundLiquidity(token, amount, { value: amount });
      return tx.wait();
    } else {
      await this.approveIfNeeded(token, this.address, amount);
      const tx = await this.contract.fundLiquidity(token, amount);
      return tx.wait();
    }
  }

  /** Fund the **compensation** bucket for `token` by `amount`.
   *  - If `token == 0x0`, sends native ETH with `value = amount`.
   *  - If ERC20, performs `approveIfNeeded(token, this.address, amount)` and calls `fundCompensation`.
   *  @returns Transaction receipt. Emits `CompensationFunded`.
   */
  async fundCompensation(
    token : Address,
    amount: bigint,
  ): Promise<TransactionReceipt> {
    if (token === ZERO_ADDR) {
      const tx = await this.contract.fundCompensation(token, amount, { value: amount });
      return tx.wait();
    } else {
      await this.approveIfNeeded(token, this.address, amount);
      const tx = await this.contract.fundCompensation(token, amount);
      return tx.wait();
    }
  }

  /* ================================================================ */
  /* 3) Write: Buy-back / Compensation / Sweep                        */
  /* ================================================================ */

  /** Execute a **forced buy-back** from `tokenIn` to `protocolToken` via router.
   *  - Deducts `amountIn` from the liquidity bucket and swaps along `path`.
   *  - Enforces cooldown: `block.timestamp - lastBuyBackAt[tokenIn] >= buyBackCooldown`.
   *  - Path **must** start with `tokenIn` and end with `protocolToken`.
   *  - Emits `BuyBackExecuted`.
   *  @returns amountOut received (protocolToken).
   *
   *  Solidity:
   *    function triggerBuyBack(
   *      address tokenIn,
   *      uint256 amountIn,
   *      uint256 minAmountOut,
   *      address[] calldata path
   *    ) external returns (uint256 amountOut)
   */
  async triggerBuyBack(
    tokenIn     : Address,
    amountIn    : bigint,
    minAmountOut: bigint,
    path        : readonly Address[],
  ): Promise<bigint> {
    const tx = await this.contract.triggerBuyBack(tokenIn, amountIn, minAmountOut, path);
    const rc = await tx.wait();
    // Parse `BuyBackExecuted(tokenIn, amountIn, amountOut, newLiquidity)` to obtain amountOut
    const parsed = rc.logs.map((l: any) => {
      try { return this.contract.interface.parseLog(l); } catch { return null; }
    }).filter(Boolean) as Array<{ name: string; args: any }>;
    const match = parsed.find(p => p.name === "BuyBackExecuted");
    if (!match) return 0n;
    // args: [tokenIn, amountIn, amountOut, newLiquidity]
    const out = match.args?.amountOut ?? match.args?.[2];
    return BigInt(out);
  }

  /** Pay compensation from the **compensation** bucket. Emits `CompensationPaid`. */
  async payCompensation(
    token : Address,
    to    : Address,
    amount: bigint,
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.payCompensation(token, to, amount);
    return tx.wait();
  }

  /** Sweep between buckets for `token`.
   *  - If `toCompensation = true`: moves from liquidity → compensation.
   *  - If `toCompensation = false`: moves from compensation → liquidity.
   *  Emits `Sweep`.
   */
  async sweep(
    token         : Address,
    amount        : bigint,
    toCompensation: boolean,
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.sweep(token, amount, toCompensation);
    return tx.wait();
  }

  /* ================================================================ */
  /* 4) Write: Admin / Pausable                                       */
  /* ================================================================ */

  /** Update the global buy-back cooldown. Only GUARDIAN_ROLE. Emits `BuyBackCooldownUpdated`. */
  async setBuyBackCooldown(newCooldownSeconds: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.setBuyBackCooldown(newCooldownSeconds);
    return tx.wait();
  }

  /** Pause state-changing entrypoints. Only PAUSER_ROLE. */
  async pause(): Promise<TransactionReceipt> {
    const tx = await this.contract.pause();
    return tx.wait();
  }

  /** Unpause state-changing entrypoints. Only PAUSER_ROLE. */
  async unpause(): Promise<TransactionReceipt> {
    const tx = await this.contract.unpause();
    return tx.wait();
  }

  /* ================================================================ */
  /* 5) Views                                                          */
  /* ================================================================ */

  /** Read the liquidity bucket for `token`. */
  async liquidityOf(token: Address): Promise<bigint> {
    const v = await this.contract.liquidityOf(token);
    return BigInt(v);
  }

  /** Read the compensation bucket for `token`. */
  async compensationOf(token: Address): Promise<bigint> {
    const v = await this.contract.compensationOf(token);
    return BigInt(v);
  }

  /** Last buy-back timestamp (per tokenIn). */
  async lastBuyBackAt(tokenIn: Address): Promise<bigint> {
    const v = await this.contract.lastBuyBackAt(tokenIn);
    return BigInt(v);
  }

  /** Global buy-back cooldown (seconds). */
  async buyBackCooldown(): Promise<bigint> {
    const v = await this.contract.buyBackCooldown();
    return BigInt(v);
  }

  /** AMM router address used by the pool. */
  async router(): Promise<Address> {
    return (await this.contract.router()) as Address;
  }

  /** Protocol token address (buy-back target; must be `path[path.length-1]`). */
  async protocolToken(): Promise<Address> {
    return (await this.contract.protocolToken()) as Address;
  }

  /* ================================================================ */
  /* 6) Event Queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `LiquidityFunded` events. */
  async queryLiquidityFunded(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.LiquidityFunded);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `CompensationFunded` events. */
  async queryCompensationFunded(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.CompensationFunded);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `BuyBackExecuted` events. */
  async queryBuyBackExecuted(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.BuyBackExecuted);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `CompensationPaid` events. */
  async queryCompensationPaid(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.CompensationPaid);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `Sweep` events. */
  async querySweep(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Sweep);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `BuyBackCooldownUpdated` events. */
  async queryBuyBackCooldownUpdated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.BuyBackCooldownUpdated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /* ================================================================ */
  /* 7) Internal Utils                                                 */
  /* ================================================================ */

  /** Ensure allowance from `owner` (current signer) to `spender` ≥ `amount`.
   *  - If insufficient, sends a single `approve(spender, MAX_UINT)` to minimize future approvals.
   *  - No-op when `token == 0x0` (ETH) — approvals are for ERC-20 only.
   */
  private async approveIfNeeded(
    token  : Address,
    spender: Address,
    amount : bigint,
  ): Promise<void> {
    if (token === ZERO_ADDR) return;

    // Determine current `owner` (signer address)
    const signer = this.runner as ethers.Signer;
    const owner  = await signer.getAddress();

    const erc20  = new ethers.Contract(token, ERC20_ABI, signer);
    const current: bigint = BigInt(await erc20.allowance(owner, spender));
    if (current >= amount) return;

    const tx = await erc20.approve(spender, MAX_UINT);
    await tx.wait();
  }
}
