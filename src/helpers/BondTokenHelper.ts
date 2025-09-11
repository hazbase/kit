/* ------------------------------------------------------------------ */
/*  BondTokenHelper — ERC-3475 Class/Nonce bond with snapshots        */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  TransactionReceipt,
} from "ethers";
import type {
  InterfaceAbi,
  TypedDataDomain,
  TypedDataField,
  BytesLike,
  BigNumberish,
} from "ethers";

import { BondToken } from "../contracts/BondToken"; // ABI (TypeChain/abi-exporter)
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                             Types                                   */
/* ------------------------------------------------------------------ */

/** ERC-3475 key/value metadata entry. */
export interface Values { key: string; value: string; }

/** Deploy-time args — mirrors `initialize(admin, forwarders)` */
export interface DeployArgs {
  /** DEFAULT_ADMIN_ROLE holder (also granted MINTER_ROLE) */
  admin: string;
  /** ERC-2771 trusted forwarders (can be empty) */
  trustedForwarders?: readonly string[];
}

/** Result of deployment via factory. (use `res.address`, not `res.proxy`) */
export interface DeployResult {
  /** Proxy address of the newly created instance */
  address: string;
  /** Deployment + initialize tx receipt */
  receipt: TransactionReceipt;
  /** Connected helper */
  helper: BondTokenHelper;
}

/** EIP-712 PermitForAll payload (mirrors Solidity PERMIT_TYPEHASH). */
export interface PermitForAllStruct {
  owner:    string;
  operator: string;
  approved: boolean;
  nonce:    bigint;
  deadline: bigint;
}

/** Signature parts used by `payCouponWithPermit`-like flows (if needed). */
export interface SigParts { v: number; r: BytesLike; s: BytesLike; }

/* EIP-712 schema (mirror of Solidity’s PERMIT_TYPEHASH) */
const PERMIT_TYPES: Record<string, TypedDataField[]> = {
  PermitForAll: [
    { name: "owner",    type: "address" },
    { name: "operator", type: "address" },
    { name: "approved", type: "bool"    },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/* ------------------------------------------------------------------ */
/*                              Events                                 */
/* ------------------------------------------------------------------ */

const EVT = {
  ClassCreated          : "ClassCreated(uint256)",
  NonceCreated          : "NonceCreated(uint256,uint256)",
  Transfer              : "Transfer(address,address,uint256,uint256,uint256)",
  Redeemed              : "Redeemed(address,uint256,uint256,uint256)",
  ClassTransferableSet  : "ClassTransferableSet(uint256,bool)",
  Snapshot              : "Snapshot(uint256)",
} as const;

/* ------------------------------------------------------------------ */
/*                              Helper                                 */
/* ------------------------------------------------------------------ */

export class BondTokenHelper {
  readonly address : string;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: string, runner: ContractRunner) {
    this.address  = ethers.getAddress(address);
    this.runner   = runner;
    this.contract = new ethers.Contract(this.address, BondToken.abi as InterfaceAbi, runner);
  }

  /* ================================================================ */
  /* 1) Deploy / Attach / Connect                                      */
  /* ================================================================ */

  /** Deploy a new BondToken proxy and return a connected helper.
   *  Purpose: Initialize an ERC-3475 Class/Nonce bond token with snapshots, whitelist, and EIP-712 permit.
   *  @param args   `{ admin, trustedForwarders }` for `initialize`.
   *  @param signer Signer used to deploy and call the initializer.
   *  @param opts   Optional factory options (salt, factory address, gas).
   *  @returns      `{ address, receipt, helper }` for immediate use.
   */
  static async deploy(
    args: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions, "contractType"|"implABI"|"initArgs"|"signer">>
  ): Promise<DeployResult> {
    const res = await deployViaFactory({
      contractType : BondToken.contractType, // e.g., "BondToken"
      implABI      : BondToken.abi,
      initArgs     : [ args.admin, args.trustedForwarders ?? [] ],
      signer,
      ...(opts ?? {}),
    });

    const helper = new BondTokenHelper(res.address, signer);
    return { address: res.address, receipt: res.receipt, helper };
  }

  /** Attach to an existing BondToken at `address`.
   *  Purpose: Bind a helper to an already deployed instance.
   *  @param address Target contract address.
   *  @param runner  Signer or provider for calls/txs.
   *  @returns       Connected helper instance.
   */
  static attach(address: string, runner: ContractRunner | ethers.Signer): BondTokenHelper {
    return new BondTokenHelper(address, runner);
  }

  /** Return a new helper bound to a different signer/runner.
   *  Purpose: Swap wallet/provider without re-attaching.
   *  @param runner New signer or provider.
   *  @returns      New helper instance sharing the same address.
   */
  connect(runner: ContractRunner | ethers.Signer): BondTokenHelper {
    if (runner === this.runner) return this;
    return new BondTokenHelper(this.address, runner);
  }

  /* ================================================================ */
  /* 2) Class / Nonce metadata & admin                                 */
  /* ================================================================ */

  /** Create a new class with metadata (MINTER_ROLE).
   *  @param classId Class identifier.
   *  @param data    Array of `{ key, value }` metadata entries.
   *  @returns       Transaction receipt. Emits `ClassCreated(classId)`.
   */
  async createClass(classId: BigNumberish, data: Values[]): Promise<TransactionReceipt> {
    const tx = await this.contract.createClass(classId, data);
    return tx.wait();
  }

  /** Create a new nonce under an existing class (MINTER_ROLE).
   *  @param classId Class identifier (must exist).
   *  @param nonceId Nonce identifier (must be unused).
   *  @param data    Array of `{ key, value }` metadata entries.
   *  @returns       Transaction receipt. Emits `NonceCreated(classId, nonceId)`.
   */
  async createNonce(classId: BigNumberish, nonceId: BigNumberish, data: Values[]): Promise<TransactionReceipt> {
    const tx = await this.contract.createNonce(classId, nonceId, data);
    return tx.wait();
  }

  /** Toggle class transferability (MINTER_ROLE).
   *  @param classId Class identifier.
   *  @param ok      `true` to allow transfers; `false` to lock.
   *  @returns       Transaction receipt. Emits `ClassTransferableSet(classId, ok)`.
   */
  async setClassTransferable(classId: BigNumberish, ok: boolean): Promise<TransactionReceipt> {
    const tx = await this.contract.setClassTransferable(classId, ok);
    return tx.wait();
  }

  /** Configure an external whitelist registry (MINTER_ROLE).
   *  @param registry Whitelist contract address (0x0 to disable checks).
   *  @returns        Transaction receipt upon inclusion.
   */
  async setWhitelist(registry: string): Promise<TransactionReceipt> {
    const tx = await this.contract.setWhitelist(registry);
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Lifecycle: issue / transfer / redeem / burn                    */
  /* ================================================================ */

  /** Mint bond units to `to` for (classId, nonceId) (MINTER_ROLE, whenNotPaused).
   *  @param to       Recipient address.
   *  @param classId  Class identifier.
   *  @param nonceId  Nonce identifier.
   *  @param amount   Units to mint.
   *  @returns        Transaction receipt. Emits `Transfer(0x0, to, ...)`.
   */
  async issue(to: string, classId: BigNumberish, nonceId: BigNumberish, amount: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.issue(to, classId, nonceId, amount);
    return tx.wait();
  }

  /** Transfer bond units from caller to `to` (whenNotPaused).
   *  @param to       Recipient address.
   *  @param classId  Class identifier.
   *  @param nonceId  Nonce identifier.
   *  @param amount   Units to transfer.
   *  @returns        Transaction receipt. Emits `Transfer(from, to, ...)`.
   */
  async transfer(to: string, classId: BigNumberish, nonceId: BigNumberish, amount: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.transfer(to, classId, nonceId, amount);
    return tx.wait();
  }

  /** Operator transfer with approval (or MINTER_ROLE) (whenNotPaused).
   *  @param from     Token owner (must approve caller via `setApprovalForAll` or caller has MINTER_ROLE).
   *  @param to       Recipient address.
   *  @param classId  Class identifier.
   *  @param nonceId  Nonce identifier.
   *  @param amount   Units to transfer.
   *  @returns        Transaction receipt. Emits `Transfer(from, to, ...)`.
   */
  async operatorTransferFrom(
    from: string, to: string, classId: BigNumberish, nonceId: BigNumberish, amount: BigNumberish
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.operatorTransferFrom(from, to, classId, nonceId, amount);
    return tx.wait();
  }

  /** Redeem (burn) from caller (whenNotPaused).
   *  @param classId  Class identifier.
   *  @param nonceId  Nonce identifier.
   *  @param amount   Units to redeem.
   *  @returns        Transaction receipt. Emits `Redeemed(msg.sender, ...)`.
   */
  async redeem(classId: BigNumberish, nonceId: BigNumberish, amount: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.redeem(classId, nonceId, amount);
    return tx.wait();
  }

  /** Burn from an arbitrary holder (MINTER_ROLE, whenNotPaused).
   *  @param from     Address to burn from.
   *  @param classId  Class identifier.
   *  @param nonceId  Nonce identifier.
   *  @param amount   Units to burn.
   *  @returns        Transaction receipt. Emits `Redeemed(from, ...)`.
   */
  async burn(from: string, classId: BigNumberish, nonceId: BigNumberish, amount: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.burn(from, classId, nonceId, amount);
    return tx.wait();
  }

  /* ================================================================ */
  /* 4) Approvals: setApprovalForAll / permitForAll                    */
  /* ================================================================ */

  /** Approve or revoke an operator for all of caller’s positions.
   *  @param operator Operator address to set.
   *  @param approved `true` to approve; `false` to revoke.
   *  @returns        Transaction receipt upon inclusion.
   */
  async setApprovalForAll(operator: string, approved: boolean): Promise<TransactionReceipt> {
    const tx = await this.contract.setApprovalForAll(operator, approved);
    return tx.wait();
  }

  /** Check operator approval for `owner`.
   *  @param owner    Token owner address.
   *  @param operator Operator address to check.
   *  @returns        `true` iff operator is approved for all.
   */
  async isApprovedForAll(owner: string, operator: string): Promise<boolean> {
    return this.contract.isApprovedForAll(owner, operator) as Promise<boolean>;
  }

  /** Read current EIP-712 permit nonce for `owner`.
   *  @param owner Address whose nonce to read.
   *  @returns     Current nonce value.
   */
  async nonces(owner: string): Promise<bigint> {
    return this.contract.nonces(owner) as Promise<bigint>;
  }

  /** Submit an on-chain PermitForAll (gasless approval) using a signature.
   *  @param owner     Owner address (signer on the signature).
   *  @param operator  Operator to approve or revoke.
   *  @param approved  `true` to approve; `false` to revoke.
   *  @param deadline  UNIX seconds; signature is invalid after this moment.
   *  @param vrs       Signature parts `{ v, r, s }`.
   *  @returns         Transaction receipt upon inclusion.
   */
  async permitForAll(
    owner: string,
    operator: string,
    approved: boolean,
    deadline: BigNumberish,
    vrs: SigParts
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.permitForAll(owner, operator, approved, deadline, vrs.v, vrs.r, vrs.s);
    return tx.wait();
  }

  /** Produce an EIP-712 signature for PermitForAll (off-chain).
   *  @param signer    Signer to produce the signature (must match `owner`).
   *  @param payload   `{ owner, operator, approved, deadline }` (nonce is fetched externally).
   *  @param chainId   Chain id for the EIP-712 domain.
   *  @param verifyingContract Address of the BondToken contract.
   *  @param currentNonce Current nonce for `owner` (from `nonces(owner)`).
   *  @returns         Hex signature string suitable for `permitForAll`.
   */
  async signPermitForAll(
    signer: ethers.Signer,
    payload: Omit<PermitForAllStruct, "nonce">,
    chainId: number,
    verifyingContract: string,
    currentNonce: bigint
  ): Promise<string> {
    const domain: TypedDataDomain = {
      name: "BondToken",
      version: "1",
      chainId,
      verifyingContract,
    };
    const data: PermitForAllStruct = { ...payload, nonce: currentNonce };
    return signer.signTypedData(domain, PERMIT_TYPES, data);
  }

  /* ================================================================ */
  /* 5) Snapshots & historical reads                                   */
  /* ================================================================ */

  /** Create a new snapshot id (MINTER_ROLE).
   *  Purpose: Finalize “dirty” balances/supply and increment `_snapId`.
   *  @returns `{ id, receipt }` where `id` is parsed from the `Snapshot(id)` event.
   */
  async snapshot(): Promise<{ id: bigint | null; receipt: TransactionReceipt }> {
    const tx = await this.contract.snapshot();
    const receipt = await tx.wait();

    // Extract id from Snapshot(id)
    let id: bigint | null = null;
    for (const log of receipt.logs) {
      try {
        const ev = this.contract.interface.parseLog(log);
        if (ev?.name === "Snapshot") {
          id = BigInt(ev.args?.id ?? ev.args?.[0]);
          break;
        }
      } catch { /* ignore */ }
    }
    return { id, receipt };
  }

  /** Historical balance at snapshot `id`.
   *  @param holder  Account address.
   *  @param classId Class identifier.
   *  @param nonceId Nonce identifier.
   *  @param id      Snapshot id (≥ 1; id=1 is the bootstrap baseline).
   *  @returns       Balance recorded at that snapshot.
   */
  async balanceOfAt(holder: string, classId: BigNumberish, nonceId: BigNumberish, id: BigNumberish): Promise<bigint> {
    return this.contract.balanceOfAt(holder, classId, nonceId, id) as Promise<bigint>;
  }

  /** Historical total supply at snapshot `id`.
   *  @param classId Class identifier.
   *  @param nonceId Nonce identifier.
   *  @param id      Snapshot id.
   *  @returns       Total supply recorded at that snapshot.
   */
  async totalSupplyAt(classId: BigNumberish, nonceId: BigNumberish, id: BigNumberish): Promise<bigint> {
    return this.contract.totalSupplyAt(classId, nonceId, id) as Promise<bigint>;
  }

  /* ================================================================ */
  /* 6) Views                                                          */
  /* ================================================================ */

  /** Current balance for (classId, nonceId). */
  async balanceOf(owner: string, classId: BigNumberish, nonceId: BigNumberish): Promise<bigint> {
    return this.contract.balanceOf(owner, classId, nonceId) as Promise<bigint>;
  }

  /** Current total supply for (classId, nonceId). */
  async totalSupply(classId: BigNumberish, nonceId: BigNumberish): Promise<bigint> {
    return this.contract.totalSupply(classId, nonceId) as Promise<bigint>;
  }

  /** Class transferability flag (public mapping). */
  async classTransferable(classId: BigNumberish): Promise<boolean> {
    return this.contract.classTransferable(classId) as Promise<boolean>;
  }

  /** Return all class metadata pairs. */
  async classData(classId: BigNumberish): Promise<Values[]> {
    return this.contract.classData(classId) as Promise<Values[]>;
  }

  /** Return all nonce metadata pairs. */
  async nonceData(classId: BigNumberish, nonceId: BigNumberish): Promise<Values[]> {
    return this.contract.nonceData(classId, nonceId) as Promise<Values[]>;
  }

  /** Indexed class metadata accessor (key,value). */
  async classDataAt(classId: BigNumberish, index: BigNumberish): Promise<{ key: string; value: string }> {
    const res = await this.contract.classDataAt(classId, index);
    const key = (res.key ?? res[0]) as string;
    const value = (res.value ?? res[1]) as string;
    return { key, value };
  }

  /** ERC-165 interface support. */
  async supportsInterface(iid: BytesLike): Promise<boolean> {
    return this.contract.supportsInterface(iid) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 7) Pausable                                                       */
  /* ================================================================ */

  /** Pause state-changing entrypoints (PAUSER_ROLE). */
  async pause(): Promise<TransactionReceipt> {
    const tx = await this.contract.pause();
    return tx.wait();
  }

  /** Unpause state-changing entrypoints (PAUSER_ROLE). */
  async unpause(): Promise<TransactionReceipt> {
    const tx = await this.contract.unpause();
    return tx.wait();
  }

  /* ================================================================ */
  /* 8) Event queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `ClassCreated(classId)` events. */
  async queryClassCreated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.ClassCreated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `NonceCreated(classId, nonceId)` events. */
  async queryNonceCreated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.NonceCreated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `Transfer(from,to,classId,nonceId,amount)` events. */
  async queryTransfer(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Transfer);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `Redeemed(from,classId,nonceId,amount)` events. */
  async queryRedeemed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Redeemed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `ClassTransferableSet(classId,allowed)` events. */
  async queryClassTransferableSet(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.ClassTransferableSet);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `Snapshot(id)` events. */
  async querySnapshot(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Snapshot);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }
}

export default BondTokenHelper;
