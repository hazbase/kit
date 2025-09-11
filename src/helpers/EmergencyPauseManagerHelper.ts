/* ------------------------------------------------------------------ */
/*  EmergencyPauseManagerHelper — Developer-friendly wrapper           */
/* ------------------------------------------------------------------ */
/*  Overview
    - Mirrors EmergencyPauseManager.sol (UUPS + ERC2771 + RolesCommon).
    - Exposes typed, ergonomic helpers for common flows:
        * deploy (proxy via factory), attach, connect
        * registerPausable / removePausable
        * pauseAll / unpauseAll
        * views: getTargets, checkAllPaused, maxTargets
        * event queries: TargetRegistered, TargetRemoved, PausedAll, UnpausedAll,
                         PauseFailed, UnpauseFailed
                         */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  TransactionReceipt,
} from 'ethers';
import type { InterfaceAbi } from 'ethers';

import { EmergencyPauseManager as EPM } from '../contracts/EmergencyPauseManager'; // ↺ ABI bundle (TypeChain/abi-exporter)
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from '../deployViaFactory';

/* ------------------------------------------------------------------ */
/*                             Types                                   */
/* ------------------------------------------------------------------ */

export type Address = string;

/** Result of deployment via factory. */
export interface DeployResult {
  address: Address;                 // Proxy address (use res.address)
  receipt: TransactionReceipt;      // Deployment/initialize tx receipt
  helper : EmergencyPauseManagerHelper; // Connected helper
}

/** Deploy-time arguments mapped to EmergencyPauseManager.initialize(...) */
export interface DeployArgs {
  admin      : Address;             // ADMIN_ROLE holder
  forwarders : readonly Address[];  // ERC-2771 trusted forwarders
}

/* ------------------------------------------------------------------ */
/*                             Events                                  */
/* ------------------------------------------------------------------ */
/* Event names for queryFilter convenience; they must exist in the ABI. */
const EVT = {
  TargetRegistered: 'TargetRegistered',
  TargetRemoved   : 'TargetRemoved',
  PausedAll       : 'PausedAll',
  UnpausedAll     : 'UnpausedAll',
  PauseFailed     : 'PauseFailed',
  UnpauseFailed   : 'UnpauseFailed',
} as const;

/* ------------------------------------------------------------------ */
/*                              Helper                                 */
/* ------------------------------------------------------------------ */

export class EmergencyPauseManagerHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner) {
    this.address  = ethers.getAddress(address) as Address;
    this.runner   = runner;
    this.contract = new ethers.Contract(this.address, EPM.abi as InterfaceAbi, runner);
  }

  /* ================================================================ */
  /* 1) Factory Deploy / Attach / Connect                             */
  /* ================================================================ */

  /** Deploy a new EmergencyPauseManager proxy via your factory helper.
   *  - Initializes with: `initialize(admin, forwarders)`.
   */
  static async deploy(
    { admin, forwarders }: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions, 'contractType' | 'implABI' | 'initArgs' | 'signer'>>
  ): Promise<DeployResult> {
    const res = await deployViaFactory({
      contractType : EPM.contractType, // e.g., "EmergencyPauseManager"
      implABI      : EPM.abi,
      initArgs     : [admin, forwarders],
      signer,
      ...(opts ?? {}),
    });

    const helper = new EmergencyPauseManagerHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach an existing EmergencyPauseManager at `address`. */
  static attach(address: Address, runner: ContractRunner | ethers.Signer): EmergencyPauseManagerHelper {
    return new EmergencyPauseManagerHelper(address, runner);
  }

  /** Return a new helper bound to a different runner/signer. */
  connect(runner: ContractRunner | ethers.Signer): EmergencyPauseManagerHelper {
    if (runner === this.runner) return this;
    return new EmergencyPauseManagerHelper(this.address, runner);
  }

  /* ================================================================ */
  /* 2) Registry management                                            */
  /* ================================================================ */

  /** Register a new Pausable-compatible target contract.
   *  @param target  Target contract address implementing `pause()` / `unpause()`.
   *  @returns       Transaction receipt. Emits `TargetRegistered(target)`.
   *
   *  Requirements (on-chain):
   *    - Caller must have `PAUSER_ROLE`.
   *    - `target` must be a contract and **not** this manager itself.
   *    - The registry length must be `< MAX_TARGETS`.
   *
   *  Solidity:
   *    function registerPausable(address target) external onlyRole(PAUSER_ROLE);
   */
  async registerPausable(target: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.registerPausable(target);
    return tx.wait();
  }

  /** Remove a previously registered target.
   *  @param target  Address to remove.
   *  @returns       Transaction receipt. Emits `TargetRemoved(target)`.
   *
   *  Requirements (on-chain):
   *    - Caller must have `PAUSER_ROLE`.
   *    - Target must exist in the set.
   *
   *  Solidity:
   *    function removePausable(address target) external onlyRole(PAUSER_ROLE);
   */
  async removePausable(target: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.removePausable(target);
    return tx.wait();
  }

  /** Return the full list of registered targets.
   *  @returns address[] Array of target addresses (current snapshot).
   *
   *  Solidity:
   *    function getTargets() external view returns(address[] memory);
   */
  async getTargets(): Promise<Address[]> {
    const arr = await this.contract.getTargets();
    return (arr as string[]).map(ethers.getAddress) as Address[];
  }

  /* ================================================================ */
  /* 3) Pause / Unpause batch operations                               */
  /* ================================================================ */

  /** Batch-call `pause()` on all registered targets.
   *  - Emits `PausedAll(msg.sender)` after attempting all targets.
   *  - For each target failure, emits `PauseFailed(target)`; the batch continues.
   *  @returns Transaction receipt.
   *
   *  Requirements (on-chain):
   *    - Caller must have `GUARDIAN_ROLE`.
   *
   *  Solidity:
   *    function pauseAll() external onlyRole(GUARDIAN_ROLE);
   */
  async pauseAll(): Promise<TransactionReceipt> {
    const tx = await this.contract.pauseAll();
    return tx.wait();
  }

  /** Batch-call `unpause()` on all registered targets.
   *  - Emits `UnpausedAll(msg.sender)` after attempting all targets.
   *  - For each target failure, emits `UnpauseFailed(target)`; the batch continues.
   *  @returns Transaction receipt.
   *
   *  Requirements (on-chain):
   *    - Caller must have `GOVERNOR_ROLE`.
   *
   *  Solidity:
   *    function unpauseAll() external onlyRole(GOVERNOR_ROLE);
   */
  async unpauseAll(): Promise<TransactionReceipt> {
    const tx = await this.contract.unpauseAll();
    return tx.wait();
  }

  /** Check if **all** targets currently report `paused() == true`.
   *  - Internally uses `staticcall` to each target’s `paused()`; returns `false` if any call fails.
   *  @returns boolean
   *
   *  Solidity:
   *    function checkAllPaused() external view returns (bool);
   */
  async checkAllPaused(): Promise<boolean> {
    return this.contract.checkAllPaused() as Promise<boolean>;
  }

  /* ================================================================ */
  /* 4) Views / constants                                              */
  /* ================================================================ */

  /** Read `MAX_TARGETS` constant from the contract, if exposed as public. */
  async maxTargets(): Promise<bigint> {
    // Many contracts expose `uint256 public constant MAX_TARGETS = N;`
    // which compiles to an auto-generated getter `MAX_TARGETS()`.
    const v = await this.contract.MAX_TARGETS?.();
    return BigInt(v ?? 0);
  }

  /* ================================================================ */
  /* 5) Event Queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `TargetRegistered(target)` events. */
  async queryTargetRegistered(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.TargetRegistered);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `TargetRemoved(target)` events. */
  async queryTargetRemoved(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.TargetRemoved);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `PausedAll(pauser)` events. */
  async queryPausedAll(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.PausedAll);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `UnpausedAll(pauser)` events. */
  async queryUnpausedAll(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.UnpausedAll);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `PauseFailed(target)` events. */
  async queryPauseFailed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.PauseFailed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `UnpauseFailed(target)` events. */
  async queryUnpauseFailed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.UnpauseFailed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /* ================================================================ */
  /* 6) Role helpers (optional conveniences)                           */
  /* ================================================================ */

  /** Grant a role (bytes32) to an account. Requires `DEFAULT_ADMIN_ROLE`. */
  async grantRole(role: string, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.grantRole(role, account);
    return tx.wait();
  }

  /** Revoke a role (bytes32) from an account. Requires `DEFAULT_ADMIN_ROLE`. */
  async revokeRole(role: string, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.revokeRole(role, account);
    return tx.wait();
  }

  /** Renounce a role (bytes32) for the connected signer (self). */
  async renounceRole(role: string, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.renounceRole(role, account);
    return tx.wait();
  }

  /** Check if `account` holds `role`. */
  async hasRole(role: string, account: Address): Promise<boolean> {
    return this.contract.hasRole(role, account) as Promise<boolean>;
  }
}

export default EmergencyPauseManagerHelper;
