/* ------------------------------------------------------------------ */
/*  StakingHelper — Multi-asset staking pool (ERC20/721/1155)         */
/*  (UUPS + ERC2771 + AccessControl + Pausable)                        */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  TransactionReceipt,
  ZeroAddress
} from "ethers";
import type { InterfaceAbi } from "ethers";

import { Staking } from "../contracts/Staking";
import {
  deployViaFactory,
  DeployViaFactoryOptions
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;

export interface DeployArgs {
  /** DEFAULT_ADMIN_ROLE holder */
  admin: Address;
  /** ERC20 reward token address */
  rewardToken: Address;
  /** Emission duration per deposit cycle (seconds) */
  duration: number;
  /** Stake cooldown (seconds; 0 disables) */
  cooldownSecs: number;
  /** Deposit fee in BPS for ERC20/1155 (0..500) */
  depositFeeBps: number;
  /** Fee recipient (ZeroAddress ⇒ burn) */
  feeTreasury: Address;
  /** Initially allowed staking assets (arrowlist) */
  initialArrowlist: readonly Address[];
  /** ERC-2771 trusted forwarders */
  forwarders?: readonly Address[];
}

export interface DeployResult {
  /** Proxy address (deployViaFactory returns `.address`) */
  address: Address;
  /** Deployment + initialize tx receipt */
  receipt: TransactionReceipt;
  /** Connected helper */
  helper: StakingHelper;
}

export interface ActionParams {
  /** Destination contract (must be rewardToken or arrowlisted token) */
  target: Address;
  /** ETH value forwarded with the call */
  value: bigint;
  /** Calldata (must include a 4-byte selector at head) */
  data: ethers.BytesLike;
  /** Delay (seconds) from now until first execution */
  delay: bigint;
  /** If true, the action will be rescheduled repeatedly */
  recurring: boolean;
  /** Interval (seconds) for recurring actions (required if recurring) */
  interval: bigint;
}

export interface Position {
  shares: bigint;
  rewardDebt: bigint;
}

export interface OptionalArgs {
  abi?: InterfaceAbi
}

/* ------------------------------------------------------------------ */
/*                               Events                                */
/* ------------------------------------------------------------------ */

const EVT = {
  Staked            : "Staked",
  Unstaked          : "Unstaked",
  RewardClaimed     : "RewardClaimed",
  ActionScheduled   : "ActionScheduled",
  ActionExecuted    : "ActionExecuted",
  CooldownUpdated   : "CooldownUpdated",
  DepositFeeUpdated : "DepositFeeUpdated",
  TokenArrowed      : "TokenArrowed",
} as const;

/* ------------------------------------------------------------------ */
/*                               Helper                                */
/* ------------------------------------------------------------------ */

export class StakingHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;
  readonly ops     : OptionalArgs | undefined;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner, ops?: OptionalArgs) {
    this.address  = ethers.getAddress(address) as Address;
    this.runner   = runner;

    this.ops = ops;
    this.contract = new ethers.Contract(this.address, ops?.abi? [...Staking.abi, ...ops.abi]: Staking.abi, runner);
  }

  /* ================================================================ */
  /* 1) Factory deploy / attach / connect                              */
  /* ================================================================ */

  /** Deploy a new staking proxy and return a connected helper. */
  static async deploy(
    args: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions, "contractType" | "implABI" | "initArgs" | "signer">>
  ): Promise<DeployResult> {
    const res = await deployViaFactory({
      contractType : Staking.contractType,  // e.g., "Staking"
      implABI      : Staking.abi,
      initArgs     : [
        args.admin,
        args.rewardToken,
        args.duration,
        args.cooldownSecs,
        args.depositFeeBps,
        args.feeTreasury,
        args.initialArrowlist,
        args.forwarders ?? []
      ],
      signer,
      ...(opts ?? {}),
    });

    const helper = new StakingHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing staking proxy at `address`. */
  static attach(address: Address, runner: ContractRunner, ops?: OptionalArgs): StakingHelper {
    return new StakingHelper(address, runner, ops);
  }

  /** Return a new helper bound to a different signer/runner. */
  connect(runner: ContractRunner): StakingHelper {
    if (runner === this.runner) return this;
    return new StakingHelper(this.address, runner, this.ops);
  }

  /* ================================================================ */
  /* 2) Admin economics                                                */
  /* ================================================================ */

  /** Fund rewards and (re)start emission. Requires ADMIN_ROLE.
   *
   * Solidity:
   *   function deposit(uint256 amount)
   *     external onlyRole(ADMIN_ROLE) nonReentrant whenNotPaused updatePool;
   */
  async deposit(amount: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.deposit(amount);
    return tx.wait();
  }

  /** Withdraw leftover rewards after the emission window ended. Requires ADMIN_ROLE.
   *
   * Solidity:
   *   function withdraw(address to)
   *     external nonReentrant whenNotPaused onlyRole(ADMIN_ROLE);
   */
  async withdraw(to: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.withdraw(to);
    return tx.wait();
  }

  /** Set stake cooldown seconds (0 disables). Requires ADMIN_ROLE. */
  async setCooldown(seconds: number | bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.setCooldown(seconds);
    return tx.wait();
  }

  /** Set rounding precision (≤ 18) for payout rounding. Requires ADMIN_ROLE. */
  async setRewardPrecision(p: number): Promise<TransactionReceipt> {
    const tx = await this.contract.setRewardPrecision(p);
    return tx.wait();
  }

  /** Configure deposit fee (0..500 bps) and fee recipient (ZeroAddress ⇒ burn). Requires ADMIN_ROLE. */
  async setDepositFee(bps: number, treasury: Address = ZeroAddress as Address): Promise<TransactionReceipt> {
    const tx = await this.contract.setDepositFee(bps, treasury);
    return tx.wait();
  }

  /** Allow or disallow a token for staking (arrowlist). Requires ADMIN_ROLE. */
  async setArrowlist(token: Address, allowed: boolean): Promise<TransactionReceipt> {
    const tx = await this.contract.setArrowlist(token, allowed);
    return tx.wait();
  }

  /** Set (or clear) the whitelist registry. Requires MINTER_ROLE. */
  async setWhitelist(registry: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.setWhitelist(registry);
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Staking (ERC20 / ERC721 / ERC1155)                             */
  /* ================================================================ */

  /** Stake ERC20 tokens (token must be arrowlisted). Requires whitelist if registry is set.
   *  Caller must `approve(pool, amount)` on the ERC20 beforehand.
   *
   * Solidity:
   *   function stakeERC20(address token, uint256 amount)
   *     external onlyWhitelisted nonReentrant updatePool;
   */
  async stakeERC20(token: Address, amount: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.stakeERC20(token, amount);
    return tx.wait();
  }

  /** Unstake ERC20 tokens.
   *
   * Solidity:
   *   function unstakeERC20(address token, uint256 amount)
   *     external nonReentrant updatePool;
   */
  async unstakeERC20(token: Address, amount: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.unstakeERC20(token, amount);
    return tx.wait();
  }

  /** Stake one ERC721 token (collection must be arrowlisted). Requires whitelist if registry is set. */
  async stakeERC721(token: Address, tokenId: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.stakeERC721(token, tokenId);
    return tx.wait();
  }

  /** Unstake one ERC721 token. */
  async unstakeERC721(token: Address, tokenId: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.unstakeERC721(token, tokenId);
    return tx.wait();
  }

  /** Stake ERC1155 units (collection must be arrowlisted). Requires whitelist if registry is set. */
  async stakeERC1155(token: Address, id: bigint, amount: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.stakeERC1155(token, id, amount);
    return tx.wait();
  }

  /** Unstake ERC1155 units. */
  async unstakeERC1155(token: Address, id: bigint, amount: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.unstakeERC1155(token, id, amount);
    return tx.wait();
  }

  /** Claim accrued reward for a given (token,id) position of the caller. Requires whitelist if registry is set.
   *
   * Solidity:
   *   function claim(address token, uint256 id)
   *     external onlyWhitelisted nonReentrant updatePool;
   */
  async claim(token: Address, id: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.claim(token, id);
    return tx.wait();
  }

  /* ================================================================ */
  /* 4) Scheduled actions                                              */
  /* ================================================================ */

  /** Schedule a call to `target` with `value` and `data`. Returns the action id extracted from the event. */
  async scheduleAction(p: ActionParams): Promise<{ id: bigint; receipt: TransactionReceipt }> {
    const tx = await this.contract.scheduleAction(
      p.target,
      p.value,
      p.data,
      p.delay,
      p.recurring,
      p.interval
    );
    const receipt = await tx.wait();
    // Parse ActionScheduled(id, target, selector, executeAfter, recurring)
    const parsed = receipt.logs
      .map((l: any) => { try { return this.contract.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean) as Array<{ name: string; args: any }>;
    const ev = parsed.find(e => e.name === "ActionScheduled");
    const id = ev ? BigInt(ev.args?.id ?? ev.args?.[0]) : 0n;
    return { id, receipt };
  }

  /** Execute a scheduled action when due; returns the `success` flag if found in events. */
  async executeAction(id: bigint): Promise<{ success: boolean | null; receipt: TransactionReceipt }> {
    const tx = await this.contract.executeAction(id);
    const receipt = await tx.wait();
    const parsed = receipt.logs
      .map((l: any) => { try { return this.contract.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean) as Array<{ name: string; args: any }>;
    const ev = parsed.find(e => e.name === "ActionExecuted");
    const success = ev ? Boolean(ev.args?.success ?? ev.args?.[2]) : null;
    return { success, receipt };
  }

  /* ================================================================ */
  /* 5) Views                                                          */
  /* ================================================================ */

  /** Compute rounded pending reward for a user position (applies `rewardPrecision`). */
  pendingReward(token: Address, id: bigint, user: Address): Promise<bigint> {
    return this.contract.pendingReward(token, id, user);
  }

  /** Compute raw (unrounded) pending reward for a user position. */
  pendingRawReward(token: Address, id: bigint, user: Address): Promise<bigint> {
    return this.contract.pendingRawReward(token, id, user);
  }

  /** Read stored position (shares, rewardDebt). */
  async position(token: Address, id: bigint, user: Address): Promise<Position> {
    const p = await this.contract.position(token, id, user);
    return { shares: BigInt(p.shares ?? p[0]), rewardDebt: BigInt(p.rewardDebt ?? p[1]) };
  }

  /** Number of scheduled actions stored on-chain. */
  actionsLength(): Promise<bigint> {
    return this.contract.actionsLength();
  }

  /* ---- Public getters (contract state) ---- */

  rewardToken(): Promise<Address> { return this.contract.rewardToken() as Promise<Address>; }
  whitelist(): Promise<Address>   { return this.contract.whitelist()   as Promise<Address>; }

  rewardRate(): Promise<bigint>          { return this.contract.rewardRate().then(BigInt); }
  finishAt(): Promise<bigint>            { return this.contract.finishAt().then(BigInt); }
  reservedReward(): Promise<bigint>      { return this.contract.reservedReward().then(BigInt); }
  rewardsDuration(): Promise<bigint>     { return this.contract.rewardsDuration().then(BigInt); }
  rewardPrecision(): Promise<number>     { return this.contract.rewardPrecision().then(Number); }
  totalShares(): Promise<bigint>         { return this.contract.totalShares().then(BigInt); }
  accRewardPerShare(): Promise<bigint>   { return this.contract.accRewardPerShare().then(BigInt); }
  lastUpdate(): Promise<bigint>          { return this.contract.lastUpdate().then(BigInt); }
  cooldownSecs(): Promise<bigint>        { return this.contract.cooldownSecs().then(BigInt); }
  depositFeeBps(): Promise<number>       { return this.contract.depositFeeBps().then(Number); }
  feeTreasury(): Promise<Address>        { return this.contract.feeTreasury() as Promise<Address>; }
  isArrowed(token: Address): Promise<boolean> { return this.contract.isArrowed(token) as Promise<boolean>; }
  lastStakeAt(user: Address): Promise<bigint> { return this.contract.lastStakeAt(user).then(BigInt); }

  /* ================================================================ */
  /* 6) Pausable                                                       */
  /* ================================================================ */

  /** Pause state-changing entrypoints. Requires PAUSER_ROLE. */
  async pause(): Promise<TransactionReceipt> {
    const tx = await this.contract.pause();
    return tx.wait();
  }

  /** Unpause state-changing entrypoints. Requires PAUSER_ROLE. */
  async unpause(): Promise<TransactionReceipt> {
    const tx = await this.contract.unpause();
    return tx.wait();
  }

  /* ================================================================ */
  /* 7) Event queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `Staked(user, token, id, amount)` events. */
  async queryStaked(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Staked);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `Unstaked(user, token, id, amount)` events. */
  async queryUnstaked(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Unstaked);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `RewardClaimed(user, amount)` events. */
  async queryRewardClaimed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.RewardClaimed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `ActionScheduled(id, target, selector, executeAfter, recurring)` events. */
  async queryActionScheduled(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.ActionScheduled);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `ActionExecuted(id, target, success)` events. */
  async queryActionExecuted(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.ActionExecuted);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `CooldownUpdated(_secs)` events. */
  async queryCooldownUpdated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.CooldownUpdated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `DepositFeeUpdated(_bps, _treasury)` events. */
  async queryDepositFeeUpdated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.DepositFeeUpdated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `TokenArrowed(token, allowed)` events. */
  async queryTokenArrowed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.TokenArrowed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }
}

export default StakingHelper;
