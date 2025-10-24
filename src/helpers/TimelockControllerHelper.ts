/* ------------------------------------------------------------------ */
/*  TimelockControllerHelper — OZ v5.3.0 (upgradeable) wrapper        */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  TransactionReceipt,
} from "ethers";
import type { BytesLike, BigNumberish } from "ethers";

import { TimelockController } from "../contracts/TimelockController"; // ↺ ABI bundle
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;
export type Bytes32 = string;

/** Constructor/initializer arguments (mirrors `.initialize`) */
export interface DeployArgs {
  /** Initial minimum delay in seconds */
  minDelay: BigNumberish;
  /** Accounts granted PROPOSER_ROLE and CANCELLER_ROLE */
  proposers: readonly Address[];
  /** Accounts granted EXECUTOR_ROLE (use address(0) to open) */
  executors: readonly Address[];
  /** Optional admin granted TIMELOCK_ADMIN_ROLE */
  admin: Address;
}

/** Result of deployment via factory. */
export interface DeployResult {
  /** Proxy address (use `res.address`) */
  address: Address;
  /** Deployment/initialize receipt */
  receipt: TransactionReceipt;
  /** Connected helper */
  helper: TimelockControllerHelper;
}

export interface OptionalArgs {
  abi?: InterfaceAbi
}

/** Operation state enum (must match OZ `OperationState`). */
export enum OperationState {
  Unset   = 0,
  Waiting = 1,
  Ready   = 2,
  Done    = 3,
}

/* ------------------------------------------------------------------ */
/*                              Constants                              */
/* ------------------------------------------------------------------ */

export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Bytes32;

/* Timelock events (names/signatures used by queryFilter) */
const EVT = {
  CallScheduled  : "CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)",
  CallExecuted   : "CallExecuted(bytes32,uint256,address,uint256,bytes)",
  Cancelled      : "Cancelled(bytes32)",
  MinDelayChange : "MinDelayChange(uint256,uint256)",
} as const;

/* ------------------------------------------------------------------ */
/*                               Helper                                */
/* ------------------------------------------------------------------ */

export class TimelockControllerHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;
  readonly ops     : OptionalArgs | undefined;

  /** Internal constructor; use `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner, ops?: OptionalArgs) {
    this.address  = ethers.getAddress(address) as Address;
    this.runner   = runner;

    this.ops = ops;
    this.contract = new ethers.Contract(this.address, ops?.abi? [...TimelockController.abi, ...ops.abi]: TimelockController.abi, runner);
  }

  /* ================================================================ */
  /* 1) Deploy / Attach / Connect                                      */
  /* ================================================================ */

  /** Deploy a new TimelockController proxy and return a connected helper. */
  static async deploy(
    args: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<
      Omit<
        DeployViaFactoryOptions,
        "contractType" | "implABI" | "initArgs" | "signer"
      >
    >
  ): Promise<DeployResult> {
    const res = await deployViaFactory({
      contractType : TimelockController.contractType, // e.g., "TimelockController"
      implABI      : TimelockController.abi,
      initArgs     : [args.minDelay, args.proposers, args.executors, args.admin],
      signer,
      ...(opts ?? {}),
    });

    const helper = new TimelockControllerHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing TimelockController at `address`. */
  static attach(address: Address, runner: ContractRunner, ops?: OptionalArgs) {
    return new TimelockControllerHelper(address, runner, ops);
  }

  /** Return a new helper bound to a different signer/runner. */
  connect(runner: ContractRunner): TimelockControllerHelper {
    if (runner === this.runner) return this;
    return new TimelockControllerHelper(this.address, runner, this.ops);
  }

  /* ================================================================ */
  /* 2) Schedule / Execute / Cancel                                    */
  /* ================================================================ */

  /** Schedule a single operation.
   *  @param target      Contract to call
   *  @param value       ETH to forward (from timelock balance)
   *  @param data        Calldata (4-byte selector + encoded args)
   *  @param predecessor Optional dependency op id (or ZERO_BYTES32)
   *  @param salt        User-chosen salt for uniqueness
   *  @param delay       Delay in seconds (≥ current minDelay)
   *  @returns           Receipt
   *
   *  Solidity:
   *    function schedule(address target, uint256 value, bytes data,
   *                      bytes32 predecessor, bytes32 salt, uint256 delay) external;
   */
  async schedule(
    target: Address,
    value: BigNumberish,
    data: BytesLike,
    predecessor: BytesLike = ZERO_BYTES32,
    salt: BytesLike,
    delay: BigNumberish
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.schedule(
      target, value, data, predecessor, salt, delay
    );
    return tx.wait();
  }

  /** Schedule a batch of operations.
   *  Arrays must have equal length; each index is a separate call under one operation id.
   *
   *  Solidity:
   *    function scheduleBatch(address[] targets, uint256[] values, bytes[] datas,
   *                           bytes32 predecessor, bytes32 salt, uint256 delay) external;
   */
  async scheduleBatch(
    targets: readonly Address[],
    values: readonly BigNumberish[],
    datas: readonly BytesLike[],
    predecessor: BytesLike = ZERO_BYTES32,
    salt: BytesLike,
    delay: BigNumberish
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.scheduleBatch(
      targets, values, datas, predecessor, salt, delay
    );
    return tx.wait();
  }

  /** Execute a single operation (must be READY).
   *
   *  Solidity:
   *    function execute(address target, uint256 value, bytes data,
   *                     bytes32 predecessor, bytes32 salt) external payable;
   */
  async execute(
    target: Address,
    value: BigNumberish,
    data: BytesLike,
    predecessor: BytesLike = ZERO_BYTES32,
    salt: BytesLike
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.execute(
      target, value, data, predecessor, salt
    );
    return tx.wait();
  }

  /** Execute a batch operation (must be READY).
   *
   *  Solidity:
   *    function executeBatch(address[] targets, uint256[] values, bytes[] datas,
   *                          bytes32 predecessor, bytes32 salt) external payable;
   */
  async executeBatch(
    targets: readonly Address[],
    values: readonly BigNumberish[],
    datas: readonly BytesLike[],
    predecessor: BytesLike = ZERO_BYTES32,
    salt: BytesLike
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.executeBatch(
      targets, values, datas, predecessor, salt
    );
    return tx.wait();
  }

  /** Cancel a scheduled (pending/waiting) operation.
   *
   *  Solidity:
   *    function cancel(bytes32 id) external;
   */
  async cancel(id: BytesLike): Promise<TransactionReceipt> {
    const tx = await this.contract.cancel(id);
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Delay management (convenience)                                 */
  /* ================================================================ */

  /** Read the current minimum delay. */
  async minDelay(): Promise<bigint> {
    const v = await this.contract.getMinDelay();
    return BigInt(v);
  }

  /** Schedule a self-call to update the minimum delay via the timelock.
   *  This is the canonical way to change delay (only the timelock can call `updateDelay`).
   *
   *  @param newDelay   New delay in seconds
   *  @param salt       Unique salt
   *  @param delay      Delay to wait before execution (≥ current minDelay)
   *  @param predecessor Optional dependency id (default ZERO_BYTES32)
   *  @returns          The operation id (hash) and the schedule receipt
   */
  async scheduleUpdateDelay(params: {
    newDelay: BigNumberish;
    salt: BytesLike;
    delay: BigNumberish;
    predecessor?: BytesLike;
  }): Promise<{ id: Bytes32; receipt: TransactionReceipt }> {
    const predecessor = params.predecessor ?? ZERO_BYTES32;
    const data = this.contract.interface.encodeFunctionData("updateDelay", [
      params.newDelay,
    ]);
    const id = await this.hashOperation(
      this.address,
      0,
      data,
      predecessor,
      params.salt
    );
    const receipt = await this.schedule(
      this.address,
      0,
      data,
      predecessor,
      params.salt,
      params.delay
    );
    return { id, receipt };
  }

  /* ================================================================ */
  /* 4) Views / Hashers / State                                        */
  /* ================================================================ */

  /** Hash for a single operation (pure on-chain function). */
  async hashOperation(
    target: Address,
    value: BigNumberish,
    data: BytesLike,
    predecessor: BytesLike,
    salt: BytesLike
  ): Promise<Bytes32> {
    return (await this.contract.hashOperation(
      target, value, data, predecessor, salt
    )) as Bytes32;
  }

  /** Hash for a batch operation (pure on-chain function). */
  async hashOperationBatch(
    targets: readonly Address[],
    values: readonly BigNumberish[],
    datas: readonly BytesLike[],
    predecessor: BytesLike,
    salt: BytesLike
  ): Promise<Bytes32> {
    return (await this.contract.hashOperationBatch(
      targets, values, datas, predecessor, salt
    )) as Bytes32;
  }

  /** Operation timestamp (0 if unset or executed). */
  async timestamp(id: BytesLike): Promise<bigint> {
    const v = await this.contract.getTimestamp(id);
    return BigInt(v);
  }

  /** Operation finite state (Unset / Waiting / Ready / Done). */
  async operationState(id: BytesLike): Promise<OperationState> {
    return (await this.contract.getOperationState(id)) as OperationState;
  }

  /** True if operation exists (any state except Unset). */
  async isOperation(id: BytesLike): Promise<boolean> {
    return this.contract.isOperation(id);
  }

  /** True if operation is pending (registered but not ready). */
  async isOperationPending(id: BytesLike): Promise<boolean> {
    return this.contract.isOperationPending(id);
  }

  /** True if operation is ready (delay elapsed, not done). */
  async isOperationReady(id: BytesLike): Promise<boolean> {
    return this.contract.isOperationReady(id);
  }

  /** True if operation is executed (done). */
  async isOperationDone(id: BytesLike): Promise<boolean> {
    return this.contract.isOperationDone(id);
  }

  /* ================================================================ */
  /* 5) AccessControl helpers (roles)                                  */
  /* ================================================================ */

  /** Read role ids (bytes32) from the contract. */
  async TIMELOCK_ADMIN_ROLE(): Promise<Bytes32> {
    return this.contract.TIMELOCK_ADMIN_ROLE() as Promise<Bytes32>;
  }
  async PROPOSER_ROLE(): Promise<Bytes32> {
    return this.contract.PROPOSER_ROLE() as Promise<Bytes32>;
  }
  async EXECUTOR_ROLE(): Promise<Bytes32> {
    return this.contract.EXECUTOR_ROLE() as Promise<Bytes32>;
  }
  async CANCELLER_ROLE(): Promise<Bytes32> {
    return this.contract.CANCELLER_ROLE() as Promise<Bytes32>;
  }

  /** Grant a role (bytes32) to an account (DEFAULT_ADMIN_ROLE required). */
  async grantRole(role: BytesLike, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.grantRole(role, account);
    return tx.wait();
  }

  /** Revoke a role (bytes32) from an account (DEFAULT_ADMIN_ROLE required). */
  async revokeRole(role: BytesLike, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.revokeRole(role, account);
    return tx.wait();
  }

  /** Renounce a role (bytes32) for the connected signer. */
  async renounceRole(role: BytesLike, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.renounceRole(role, account);
    return tx.wait();
  }

  /** Check if `account` holds `role`. */
  async hasRole(role: BytesLike, account: Address): Promise<boolean> {
    return this.contract.hasRole(role, account) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 6) ERC165                                                         */
  /* ================================================================ */

  /** ERC165 support check (useful for interface probing). */
  async supportsInterface(iid: BytesLike): Promise<boolean> {
    return this.contract.supportsInterface(iid) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 7) Event queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `CallScheduled(id,index,target,value,data,predecessor,delay)` events. */
  async queryCallScheduled(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.CallScheduled);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `CallExecuted(id,index,target,value,data)` events. */
  async queryCallExecuted(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.CallExecuted);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `Cancelled(id)` events. */
  async queryCancelled(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Cancelled);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `MinDelayChange(old,new)` events. */
  async queryMinDelayChange(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.MinDelayChange);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }
}

export default TimelockControllerHelper;
