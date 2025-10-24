/* ------------------------------------------------------------------ */
/*  DebtManagerHelper — Developer-friendly wrapper for DebtManager    */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  TransactionReceipt,
  BytesLike,
  BigNumberish,
  solidityPacked,
  keccak256,
} from "ethers";

import { DebtManager } from "../contracts/DebtManager"; // ABI bundle (TypeChain/abi-exporter)
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;
export type Bytes32 = string;

/** Deploy-time args — mirrors `initialize(admin, forwarders)` */
export interface DeployArgs {
  /** DEFAULT_ADMIN_ROLE holder */
  admin: Address;
  /** ERC-2771 trusted forwarders */
  trustedForwarders?: readonly Address[];
}

/** Result of deployment via factory (use `res.address`) */
export interface DeployResult {
  /** Proxy address */
  address: Address;
  /** Deployment/initialize tx receipt */
  receipt: TransactionReceipt;
  /** Connected helper */
  helper: DebtManagerHelper;
}

/** Enum mirror of `TrancheStatus` in Solidity */
export enum TrancheStatus {
  PENDING = 0,
  ACTIVE = 1,
  CALLED = 2,
  PUT_NOTICE = 3,
  DEFAULTED = 4,
  MATURED = 5,
}

/** Argument bag for `createTranche` */
export interface CreateTrancheArgs {
  /** ERC-3475 snapshot-capable debt token */
  token: Address;
  /** ERC-3475 class id */
  classId: BigNumberish;
  /** ERC-3475 nonce id */
  nonceId: BigNumberish;
  /** Principal ERC20 address (also used for call/put/maturity redemptions) */
  principalToken: Address;
  /** Principal per 1 debt unit (scaled to principal token decimals) */
  principalPerUnit: BigNumberish;
  /** Coupon ERC20 address (may be same as principalToken) */
  couponToken: Address;
  /** Maturity timestamp (unix seconds, must be > now at creation) */
  maturity: BigNumberish;
  /** Call price (bps, e.g., 10000 = 100%) */
  callPriceBps: BigNumberish;
  /** Put price (bps) */
  putPriceBps: BigNumberish;
  /** Call notice period (seconds) */
  callNoticeSec: BigNumberish;
  /** Put notice period (seconds) */
  putNoticeSec: BigNumberish;
}

/** Tranche info returned by `trancheInfo` */
export interface TrancheInfo {
  token: Address;
  classId: bigint;
  nonceId: bigint;
  principalToken: Address;
  principalPerUnit: bigint;
  couponToken: Address;
  maturity: bigint;
  status: TrancheStatus;
  callPriceBps: number;
  putPriceBps: number;
}

export interface OptionalArgs {
  abi?: InterfaceAbi
}

/** Coupon metadata (no snapshot fields; see notes) */
export interface CouponMeta {
  /** Coupon due timestamp (unix) */
  payDate: bigint;
  /** Informational rate (bps) */
  rateBps: bigint;
  /** Whether this epoch was paid by issuer */
  paid: boolean;
  /** Total amount provisioned by issuer for this epoch */
  totalPaid: bigint;
  /** Total amount claimed so far by holders */
  claimed: bigint;
}

/* ------------------------------------------------------------------ */
/*                               Events                                */
/* ------------------------------------------------------------------ */

const EVT = {
  TrancheCreated: "TrancheCreated(uint256,uint64)",
  CouponScheduleAdded:
    "CouponScheduleAdded(uint256,uint32,uint64,uint256)",
  CouponPaid: "CouponPaid(uint256,uint32,uint256)",
  CouponClaimed:
    "CouponClaimed(uint256,uint32,address,uint256)",
  CallNotified: "CallNotified(uint256)",
  Called: "Called(uint256,address,uint256,uint256)",
  PutNotified: "PutNotified(uint256,address)",
  PutExecuted: "PutExecuted(uint256,address,uint256)",
  Defaulted: "Defaulted(uint256,uint32)",
  PrincipalRedeemed: "PrincipalRedeemed(uint256,address,uint256)",
  TrancheClosed: "TrancheClosed(uint256,address)",
  PrincipalFunded: "PrincipalFunded(uint256,uint256)",
  SupplyAdjusted: "SupplyAdjusted(uint256,int256,int256)",
} as const;

/* ------------------------------------------------------------------ */
/*                               Helper                                */
/* ------------------------------------------------------------------ */

export class DebtManagerHelper {
  readonly address: Address;
  readonly contract: ethers.Contract;
  readonly runner: ContractRunner;
  readonly ops     : OptionalArgs | undefined;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner, ops?: OptionalArgs) {
    this.address = ethers.getAddress(address) as Address;
    this.runner = runner;

    this.ops = ops;
    this.contract = new ethers.Contract(this.address, ops?.abi? [...DebtManager.abi, ...ops.abi]: DebtManager.abi, runner);
  }

  /* ===================== Deploy / Attach / Connect ================= */

  /** Deploy a new DebtManager proxy and return a connected helper.
   *  Purpose: Initialize a snapshot-based bond/debt lifecycle manager.
   *  @param args   Deploy/initialize arguments (admin, forwarders).
   *  @param signer Ethers signer to send deployment & initializer tx.
   *  @param opts   Optional factory options (salt, factory address, etc.).
   *  @returns      `{ address, receipt, helper }` for immediate use.
   */
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
      contractType: DebtManager.contractType, // e.g., "DebtManager"
      implABI: DebtManager.abi,
      initArgs: [args.admin, args.trustedForwarders ?? []],
      signer,
      ...(opts ?? {}),
    });
    const helper = new DebtManagerHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing DebtManager at `address`.
   *  Purpose: Bind helper to a deployed proxy/implementation for calls/txs.
   *  @param address Target contract address.
   *  @param runner  Signer or provider for execution context.
   *  @returns       Connected helper instance.
   */
  static attach(address: Address, runner: ContractRunner, ops?: OptionalArgs): DebtManagerHelper {
    return new DebtManagerHelper(address, runner, ops);
  }

  /** Return a new helper bound to a different signer/runner.
   *  Purpose: Swap wallet/provider without re-attaching.
   *  @param runner New signer or provider.
   *  @returns      New helper targeting the same address.
   */
  connect(runner: ContractRunner): DebtManagerHelper {
    if (runner === this.runner) return this;
    return new DebtManagerHelper(this.address, runner, this.ops);
  }

  /* ========================= Issuer (Admin) ======================== */

  /** Create a new tranche (class/nonce) and register it as PENDING.
   *  Purpose: Set base tokens & economics before adding coupon schedule.
   *  @param a Tranche creation arguments (see `CreateTrancheArgs`).
   *  @returns Transaction receipt; use `tranchesLength()-1` to get index,
   *           or listen for `TrancheCreated(idx, maturity)`.
   */
  async createTranche(a: CreateTrancheArgs): Promise<TransactionReceipt> {
    const tx = await this.contract.createTranche(
      a.token,
      a.classId,
      a.nonceId,
      a.principalToken,
      a.principalPerUnit,
      a.couponToken,
      a.maturity,
      a.callPriceBps,
      a.putPriceBps,
      a.callNoticeSec,
      a.putNoticeSec
    );
    return tx.wait();
  }

  /** Append a coupon epoch (strictly increasing by payDate).
   *  Purpose: Build the schedule; first append moves PENDING → ACTIVE.
   *  @param idx     Tranche index.
   *  @param payDate Coupon due timestamp (unix seconds).
   *  @param rateBps Informational coupon rate in bps.
   *  @returns       Transaction receipt on success. Emits `CouponScheduleAdded`.
   */
  async addCouponSchedule(
    idx: BigNumberish,
    payDate: BigNumberish,
    rateBps: BigNumberish
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.addCouponSchedule(idx, payDate, rateBps);
    return tx.wait();
  }

  /** Provision coupon funds and take a snapshot for an epoch.
   *  Purpose: Record snapshot & per-unit payout, enabling holder claims.
   *  @param idx         Tranche index.
   *  @param epoch       Coupon epoch index.
   *  @param totalAmount Total ERC20 amount to distribute this epoch.
   *  @returns           Transaction receipt. Emits `CouponPaid`.
   */
  async payCoupon(
    idx: BigNumberish,
    epoch: number,
    totalAmount: BigNumberish
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.payCoupon(idx, epoch, totalAmount);
    return tx.wait();
  }

  /** Pay coupon using EIP-2612 `permit` on coupon token.
   *  Purpose: Fund coupon in a single tx with gasless token approval.
   *  @param idx         Tranche index.
   *  @param epoch       Coupon epoch index.
   *  @param totalAmount Total ERC20 amount to distribute this epoch.
   *  @param deadline    Permit deadline.
   *  @param sig         Signature parts `{ v, r, s }`.
   *  @returns           Transaction receipt. Emits `CouponPaid`.
   */
  async payCouponWithPermit(
    idx: BigNumberish,
    epoch: number,
    totalAmount: BigNumberish,
    deadline: BigNumberish,
    sig: { v: number; r: BytesLike; s: BytesLike }
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.payCouponWithPermit(
      idx,
      epoch,
      totalAmount,
      deadline,
      sig.v,
      sig.r,
      sig.s
    );
    return tx.wait();
  }

  /** Notify CALL (issuer side). After notice period, holders can execute call.
   *  Purpose: Move ACTIVE → CALLED, start call notice countdown.
   *  @param idx Tranche index.
   *  @returns   Transaction receipt. Emits `CallNotified`.
   */
  async notifyCall(idx: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.notifyCall(idx);
    return tx.wait();
  }

  /** Deposit principal into tranche pool (issuer funding).
   *  Purpose: Top up `principalPool`; required before payouts/redemptions.
   *  @param idx    Tranche index.
   *  @param amount Principal token amount to deposit.
   *  @returns      Transaction receipt. Emits `PrincipalFunded`.
   */
  async depositPrincipal(
    idx: BigNumberish,
    amount: BigNumberish
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.depositPrincipal(idx, amount);
    return tx.wait();
  }

  /** Notify that debt token total supply changed externally.
   *  Purpose: Recompute `requiredPrincipal` = principalPerUnit × totalSupply
   *           delta since last cache; keeps funding requirements consistent.
   *  @param idx Tranche index.
   *  @returns   Transaction receipt. Emits `SupplyAdjusted`.
   */
  async notifySupplyChange(idx: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.notifySupplyChange(idx);
    return tx.wait();
  }

  /** Check & flag default if next unpaid coupon exceeded grace.
   *  Purpose: Set status → DEFAULTED when due + grace < now and unpaid.
   *  @param idx Tranche index.
   *  @returns   Transaction receipt; emits `Defaulted` if default flagged.
   */
  async checkDefault(idx: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.checkDefault(idx);
    return tx.wait();
  }

  /** Close tranche at/after maturity (issuer sweep).
   *  Purpose: Mark MATURED and sweep remaining funds to `to` (after grace),
   *           or enforce all coupons claimed if within grace.
   *  @param idx Tranche index.
   *  @param to  Sweep recipient (non-zero).
   *  @returns   Transaction receipt. Emits `TrancheClosed`.
   */
  async closeTranche(
    idx: BigNumberish,
    to: Address
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.closeTranche(idx, to);
    return tx.wait();
  }

  /* ========================= Holder actions ======================== */

  /** Claim coupon for an epoch based on snapshot balance.
   *  Purpose: Receiver gets `balanceOfAt * perUnit` for epoch snapshot.
   *  @param idx   Tranche index.
   *  @param epoch Coupon epoch index.
   *  @returns     Transaction receipt. Emits `CouponClaimed`.
   */
  async claimCoupon(
    idx: BigNumberish,
    epoch: number
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.claimCoupon(idx, epoch);
    return tx.wait();
  }

  /** Execute CALL after issuer notice period.
   *  Purpose: Burn `amount` units and receive call price × principal.
   *  @param idx    Tranche index.
   *  @param amount Units to call (burn).
   *  @returns      Transaction receipt. Emits `Called`.
   */
  async executeCall(
    idx: BigNumberish,
    amount: BigNumberish
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.executeCall(idx, amount);
    return tx.wait();
  }

  /** File a PUT notice (requires current positive balance).
   *  Purpose: Start put notice countdown for the caller.
   *  @param idx Tranche index.
   *  @returns   Transaction receipt. Emits `PutNotified`.
   */
  async givePutNotice(idx: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.givePutNotice(idx);
    return tx.wait();
  }

  /** Execute PUT after notice period.
   *  Purpose: Burn `amount` units and receive put price × principal.
   *  @param idx    Tranche index.
   *  @param amount Units to put (burn).
   *  @returns      Transaction receipt. Emits `PutExecuted`.
   */
  async exercisePut(
    idx: BigNumberish,
    amount: BigNumberish
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.exercisePut(idx, amount);
    return tx.wait();
  }

  /** Redeem principal at/after maturity (ACTIVE or PUT_NOTICE).
   *  Purpose: Burn `amount` units and receive `principalPerUnit * amount`.
   *  @param idx    Tranche index.
   *  @param amount Units to redeem (burn).
   *  @returns      Transaction receipt. Emits `PrincipalRedeemed`.
   */
  async redeemAtMaturity(
    idx: BigNumberish,
    amount: BigNumberish
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.redeemAtMaturity(idx, amount);
    return tx.wait();
  }

  /* ============================== Views ============================ */

  /** Number of tranches created.
   *  Purpose: Utility to enumerate tranche indices.
   *  @returns `uint256` length of internal tranches array.
   */
  async tranchesLength(): Promise<bigint> {
    return BigInt(await this.contract.tranchesLength());
  }

  /** Read key tranche metadata (see `TrancheInfo`).
   *  Purpose: Fetch static economics & addresses for UI/services.
   *  @param idx Tranche index.
   *  @returns   Strongly-typed tranche info object.
   */
  async trancheInfo(idx: BigNumberish): Promise<TrancheInfo> {
    const res = await this.contract.trancheInfo(idx);
    return {
      token: ethers.getAddress(res[0]) as Address,
      classId: BigInt(res[1]),
      nonceId: BigInt(res[2]),
      principalToken: ethers.getAddress(res[3]) as Address,
      principalPerUnit: BigInt(res[4]),
      couponToken: ethers.getAddress(res[5]) as Address,
      maturity: BigInt(res[6]),
      status: Number(res[7]) as TrancheStatus,
      callPriceBps: Number(res[8]),
      putPriceBps: Number(res[9]),
    };
  }

  /** Number of coupon epochs on a tranche.
   *  Purpose: Iterate coupon schedule for display or reconciliation.
   *  @param idx Tranche index.
   *  @returns   Count of coupon epochs (`uint256` → number).
   */
  async couponCount(idx: BigNumberish): Promise<number> {
    return Number(await this.contract.couponCount(idx));
  }

  /** Return coupon epoch metadata (no snapshot/perUnit in this view).
   *  Purpose: Show coupon calendar and payout progress.
   *  @param idx Tranche index.
   *  @param ep  Coupon epoch index.
   *  @returns   `CouponMeta` object with payDate/rate/paid/totalPaid/claimed.
   */
  async couponMeta(idx: BigNumberish, ep: number): Promise<CouponMeta> {
    const c = await this.contract.couponMeta(idx, ep);
    return {
      payDate: BigInt(c[0]),
      rateBps: BigInt(c[1]),
      paid: Boolean(c[2]),
      totalPaid: BigInt(c[3]),
      claimed: BigInt(c[4]),
    };
  }

  /** Public convenience: whether `owner` claimed coupon `ep` for tranche `idx`.
   *  Purpose: Wallet UI: hide claim button when already claimed.
   *  @param idx   Tranche index.
   *  @param ep    Coupon epoch index.
   *  @param owner Holder address to check.
   *  @returns     True iff already claimed.
   */
  async isClaimed(
    idx: BigNumberish,
    ep: number,
    owner: Address
  ): Promise<boolean> {
    return this.contract.isClaimed(idx, ep, owner) as Promise<boolean>;
  }

  /* ============================= Pause ============================= */

  /** Pause state-changing entrypoints (PAUSER_ROLE).
   *  Purpose: Emergency stop to halt coupon/put/call/redemptions.
   *  @returns Transaction receipt upon inclusion.
   */
  async pause(): Promise<TransactionReceipt> {
    const tx = await this.contract.pause();
    return tx.wait();
  }

  /** Unpause state-changing entrypoints (PAUSER_ROLE).
   *  Purpose: Resume operations after an emergency.
   *  @returns Transaction receipt upon inclusion.
   */
  async unpause(): Promise<TransactionReceipt> {
    const tx = await this.contract.unpause();
    return tx.wait();
  }

  /* =========================== Event Queries ======================= */

  /** Query `TrancheCreated(idx,maturity)` events. */
  async queryTrancheCreated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.TrancheCreated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `CouponScheduleAdded(idx,epoch,payDate,rateBps)` events. */
  async queryCouponScheduleAdded(
    from?: number | string,
    to?: number | string
  ) {
    const ev = this.contract.getEvent(EVT.CouponScheduleAdded);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `CouponPaid(idx,epoch,totalAmount)` events. */
  async queryCouponPaid(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.CouponPaid);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `CouponClaimed(idx,epoch,holder,amount)` events. */
  async queryCouponClaimed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.CouponClaimed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `CallNotified(idx)` events. */
  async queryCallNotified(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.CallNotified);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `Called(idx,holder,amount,pay)` events. */
  async queryCalled(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Called);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `PutNotified(idx,holder)` events. */
  async queryPutNotified(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.PutNotified);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `PutExecuted(idx,holder,amount)` events. */
  async queryPutExecuted(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.PutExecuted);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `Defaulted(idx,missedEpoch)` events. */
  async queryDefaulted(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Defaulted);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `PrincipalRedeemed(idx,holder,amount)` events. */
  async queryPrincipalRedeemed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.PrincipalRedeemed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `TrancheClosed(idx,to)` events. */
  async queryTrancheClosed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.TrancheClosed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `PrincipalFunded(idx,amount)` events. */
  async queryPrincipalFunded(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.PrincipalFunded);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `SupplyAdjusted(idx,dUnits,dPrincipal)` events. */
  async querySupplyAdjusted(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.SupplyAdjusted);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /* ======================== Legacy Utilities ======================= */

  /** (Legacy) Build a leaf = keccak256(abi.encodePacked(index, holder, amount))
   *  Note: Current `DebtManager` uses snapshot-based coupon distribution,
   *        not Merkle-based claims. Kept for backwards-compatible tooling.
   */
  static buildLeaf(index: number, holder: Address, amount: bigint): Bytes32 {
    return keccak256(
      solidityPacked(["uint256", "address", "uint256"], [index, holder, amount])
    ) as Bytes32;
  }
}

export default DebtManagerHelper;
