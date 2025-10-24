/* ------------------------------------------------------------------ */
/*  SplitterHelper — Developer-friendly wrapper for Splitter           */
/* ------------------------------------------------------------------ */
/*  Overview
    - Mirrors Splitter.sol (UUPS, ERC2771, RolesCommon, Pausable).
    - Provides typed helpers for:
        * deploy (proxy via factory), attach, connect
        * routeERC20 (requires prior ERC20 approval), routeNative (with value)
        * setRoutes (governance)
        * pending native claims (claimPendingNative / sweepPendingNative)
        * pause / unpause
        * views: getRoutes, pendingOf
        * event queries: FeeSplit, RoutesUpdated, NativePending, PendingClaimed
        * */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  TransactionReceipt,
} from 'ethers';
import type { InterfaceAbi } from 'ethers';

import { Splitter } from '../contracts/Splitter'; // ↺ ABI bundle (TypeChain/abi-exporter)
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from '../deployViaFactory';

/* ------------------------------------------------------------------ */
/*                              Types                                  */
/* ------------------------------------------------------------------ */

/** Canonical 20-byte address string. */
export type Address = string;

/** Route struct mirror: destination and share in basis points (1–10,000). */
export interface Route { dest: string; bps: number; }

/** Result of deployment via factory. */
export interface DeployResult {
  address: string;                    // Proxy address (use res.address, not res.proxy)
  receipt: TransactionReceipt;        // Deployment/initialize tx receipt
  helper : SplitterHelper;            // Connected helper
}

export interface OptionalArgs {
  abi?: InterfaceAbi
}

/* ------------------------------------------------------------------ */
/*                            Constants                                */
/* ------------------------------------------------------------------ */

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/* ------------------------------------------------------------------ */
/*                              Events                                 */
/* ------------------------------------------------------------------ */
/* Event signatures for queryFilter convenience; must match .sol. */
const EVT = {
  FeeSplit       : 'FeeSplit(uint256,address,bool)',
  RoutesUpdated  : 'RoutesUpdated()',
  NativePending  : 'NativePending(address,uint256)',
  PendingClaimed : 'PendingClaimed(address,uint256)',
} as const;

/* ------------------------------------------------------------------ */
/*                              Helper                                 */
/* ------------------------------------------------------------------ */
export class SplitterHelper {
  readonly address : string;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;
  readonly ops     : OptionalArgs | undefined;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner, ops?: OptionalArgs) {
    this.address  = ethers.getAddress(address);
    this.runner   = runner;

    this.ops = ops;
    this.contract = new ethers.Contract(this.address, ops?.abi? [...Splitter.abi, ...ops.abi]: Splitter.abi, runner);
  }

  /* ================================================================ */
  /* 1) Factory Deploy / Attach / Connect                             */
  /* ================================================================ */

  /** Deploy a new Splitter proxy via your factory helper.
   *  - Initializes with: `initialize(admin, routes, forwarders)`.
   *  - `routes` must be 1..10 entries and sum of `bps` must be exactly 10,000.
   */
  static async deploy(
    {
      admin,
      routes,
      trustedForwarders = [],
    }: {
      admin: string;
      routes: readonly Route[];
      trustedForwarders?: readonly string[];
    },
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions, 'contractType' | 'implABI' | 'initArgs' | 'signer'>>
  ): Promise<DeployResult> {
    // Optional client-side validation to fail fast before sending a tx.
    SplitterHelper.assertRoutes(routes);

    const res = await deployViaFactory({
      contractType : Splitter.contractType,  // e.g., "Splitter"
      implABI      : Splitter.abi,
      initArgs     : [admin, routes, trustedForwarders],
      signer,
      ...(opts ?? {}),
    });

    const helper = new SplitterHelper(res.address, signer);
    return { address: res.address, receipt: res.receipt, helper };
  }

  /** Attach to an existing Splitter at `address`. */
  static attach(address: Address, runner: ContractRunner, ops?: OptionalArgs): SplitterHelper {
    return new SplitterHelper(address, runner, ops);
  }

  /** Return a new helper bound to a different runner/signer. */
  connect(runner: ContractRunner): SplitterHelper {
    if (runner === this.runner) return this;
    return new SplitterHelper(this.address, runner, this.ops);
  }

  /* ================================================================ */
  /* 2) Routing (core functionality)                                  */
  /* ================================================================ */

  /** Route ERC-20 `amount` according to current `routes`.
   *  @note The Splitter **pulls** tokens using `safeTransferFrom(msg.sender, this, amount)`.
   *        Therefore, the caller must first approve the Splitter address on the token:
   *        `await erc20.approve(splitter.address, amount)`.
   *  @returns Transaction receipt. Emits `FeeSplit(totalReceived, token, false)`.
   *
   *  Solidity:
   *    function routeERC20(IERC20 token, uint256 amount) external nonReentrant;
   */
  async routeERC20(token: string, amount: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.routeERC20(token, amount);
    return tx.wait();
  }

  /** Route native ETH (msg.value) according to current `routes`.
   *  @param amount  Amount of native ETH to route (wei). Will be sent as `value`.
   *  @returns       Transaction receipt. Emits `FeeSplit(msg.value, address(0), true)`.
   *
   *  Solidity:
   *    function routeNative() external payable nonReentrant;
   */
  async routeNative(amount: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.routeNative({ value: amount });
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Governance: routes                                             */
  /* ================================================================ */

  /** Update route set (governance). Requires `GOVERNOR_ROLE` on-chain.
   *  - Contract enforces: 1..10 items, `bps` in [1, 10_000], and sum == 10_000.
   *  - Remainder/dust is always assigned to index 0 during distribution.
   *  @returns Transaction receipt. Emits `RoutesUpdated`.
   *
   *  Solidity:
   *    function setRoutes(Route[] calldata _routes) external onlyRole(GOVERNOR_ROLE);
   */
  async setRoutes(routes: readonly Route[]): Promise<TransactionReceipt> {
    SplitterHelper.assertRoutes(routes);
    const tx = await this.contract.setRoutes(routes);
    return tx.wait();
  }

  /** Fetch current routes (best-effort by probing indices 0..9).
   *  - Splitter stores `Route[] public routes;` but does not expose `.length`.
   *  - Contract limits size to 10, so we probe up to 10 and stop on first revert.
   *  @returns Array of `{ dest, bps }` in on-chain order.
   */
  async getRoutes(): Promise<Route[]> {
    const out: Route[] = [];
    for (let i = 0; i < 10; i++) {
      try {
        const r = await this.contract.routes(i);
        // Ethers v6 tuple result: [dest, bps] with named props if ABI includes names
        const dest = ethers.getAddress(r.dest ?? r[0]);
        const bps  = Number(r.bps ?? r[1]);
        out.push({ dest, bps });
      } catch {
        break;
      }
    }
    return out;
  }

  /* ================================================================ */
  /* 4) Pending native                                                 */
  /* ================================================================ */

  /** Read pending native (wei) for `addr` accrued from failed deliveries. */
  async pendingOf(addr: string): Promise<bigint> {
    return BigInt(await this.contract.pendingNative(addr));
  }

  /** Claim caller’s pending native. Emits `PendingClaimed(msg.sender, amount)`. */
  async claimPendingNative(): Promise<TransactionReceipt> {
    const tx = await this.contract.claimPendingNative();
    return tx.wait();
  }

  /** Sweep `amount` from `dest`’s pending native to the same `dest` (governance).
   *  - Requires `GOVERNOR_ROLE` on-chain.
   *  @returns Transaction receipt. Emits `PendingClaimed(dest, amount)`.
   *
   *  Solidity:
   *    function sweepPendingNative(address dest, uint256 amount)
   *      external onlyRole(GOVERNOR_ROLE) nonReentrant;
   */
  async sweepPendingNative(dest: string, amount: bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.sweepPendingNative(dest, amount);
    return tx.wait();
  }

  /* ================================================================ */
  /* 5) Pausable                                                       */
  /* ================================================================ */

  /** Pause state-changing entrypoints. Requires `PAUSER_ROLE` on-chain. */
  async pause(): Promise<TransactionReceipt> {
    const tx = await this.contract.pause();
    return tx.wait();
  }

  /** Unpause state-changing entrypoints. Requires `PAUSER_ROLE` on-chain. */
  async unpause(): Promise<TransactionReceipt> {
    const tx = await this.contract.unpause();
    return tx.wait();
  }

  /* ================================================================ */
  /* 6) Event Queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `FeeSplit(total, asset, nativePath)` events. */
  async queryFeeSplit(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.FeeSplit);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `RoutesUpdated()` events. */
  async queryRoutesUpdated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.RoutesUpdated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `NativePending(dest, amount)` events (native delivery fallback). */
  async queryNativePending(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.NativePending);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `PendingClaimed(dest, amount)` events. */
  async queryPendingClaimed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.PendingClaimed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /* ================================================================ */
  /* 7) Utilities                                                      */
  /* ================================================================ */

  /** Validate routes: 1..10 entries, each `bps` in [1, 10000], sum == 10000, no zero dest. */
  static assertRoutes(routes: readonly Route[]): void {
    if (!routes.length || routes.length > 10) {
      throw new Error('routes length must be 1..10');
    }
    let sum = 0;
    for (const { dest, bps } of routes) {
      if (!ethers.isAddress(dest) || dest === ZERO_ADDR) throw new Error('route.dest must be a non-zero address');
      if (bps <= 0 || bps > 10_000) throw new Error('route.bps must be in [1, 10000]');
      sum += bps;
    }
    if (sum !== 10_000) throw new Error('sum of bps must equal 10,000');
  }
}

export default SplitterHelper;
