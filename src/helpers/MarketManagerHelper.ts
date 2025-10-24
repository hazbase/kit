/* ------------------------------------------------------------------ */
/*  MarketManagerHelper — Primary-sale listings & EIP-712 vouchers     */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  TransactionReceipt,
  BytesLike,
  BigNumberish,
  TypedDataDomain,
  TypedDataEncoder,
  ZeroAddress,
} from "ethers";

import { MarketManager as Market } from "../contracts/MarketManager"; // ABI bundle (TypeChain / abi-exporter)
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;
export type Bytes32 = string;

/** Deploy-time arguments mapped to `initialize(admin, splitter, bps, forwarders)` */
export interface DeployArgs {
  /** DEFAULT_ADMIN_ROLE holder */
  admin: Address;
  /** Fee receiver router (Splitter) */
  splitter: Address;
  /** Protocol fee in bps (≤ 1000 = 10%) */
  bps: number;
  /** ERC-2771 trusted forwarders (can be empty) */
  trustedForwarders?: readonly Address[];
}

/** Result of deployment via factory (uses `res.address`) */
export interface DeployResult {
  address: Address;                 // Proxy address
  receipt: TransactionReceipt;      // Deployment/initialize tx receipt
  helper : MarketManagerHelper;     // Connected helper
}

/* ── On-chain data types (mirror Solidity) ────────────────────────── */

export enum AssetKind { ERC20 = 0, ERC721 = 1, ERC1155 = 2, BOND = 3 }

export interface Asset {
  /** ERC20/721/1155/BOND selector */
  kind: AssetKind;
  /** Asset token contract address */
  token: Address | string;
  /** For ERC721: tokenId, for ERC1155: id, for BOND: classId, for ERC20: 0 */
  id: BigNumberish;
  /** For BOND only: nonceId, else 0 */
  nonceId: BigNumberish;
  /** Per-unit “ticket size”: amount of the asset delivered per 1 unit purchase */
  amount: BigNumberish;
}

/** EIP-2612-like permit data used when paying with ERC20 */
export interface PermitData {
  /** Suggested: price * qty (spender = MarketManager) */
  value: BigNumberish;
  /** Permit deadline (unix seconds) */
  deadline: BigNumberish;
  /** ECDSA signature parts */
  v: number; r: BytesLike; s: BytesLike;
}

/** Fixed-price, on-chain ask listing */
export interface Ask {
  seller: Address | string;
  asset: Asset;
  /** Price per 1 unit (token decimals or wei for ETH) */
  price: bigint;
  /** Address(0)=ETH, else ERC20 address */
  paymentToken: Address | string;
  /** Remaining units available */
  quantity: bigint;
  /** Per-wallet cap (0 = unlimited) */
  maxPerWallet: number;
  /** Start time (unix seconds) */
  startTime: bigint;
  /** End time (0 = open-ended) */
  endTime: bigint;
  /** Optional royalty receiver (if royaltyBps > 0) */
  royaltyReceiver: Address | string;
  /** Royalty in bps (0..10000) */
  royaltyBps: number;
  /** Optional AgreementManager (delegated settlement) */
  agreement: Address | string;
  /** Offer id at AgreementManager (required if agreement != 0) */
  offerId: Bytes32;
}

/** Off-chain EIP-712 signed voucher (lazy listing) */
export interface Voucher {
  asset: Asset;
  price: BigNumberish;
  paymentToken: Address;
  quantity: BigNumberish;
  maxPerWallet: BigNumberish; // uint64
  startTime: BigNumberish;    // uint64
  endTime: BigNumberish;      // uint64
  royaltyReceiver: Address;
  royaltyBps: number;         // uint16
  salt: BigNumberish;
  seller: Address;
}

export interface OptionalArgs {
  abi?: InterfaceAbi
}

/* ------------------------------------------------------------------ */
/*                         EIP-712 definitions                         */
/* ------------------------------------------------------------------ */

const EIP712_NAME    = "MarketManager";
const EIP712_VERSION = "1";

/** EIP-712 struct types used by `redeemVoucher` / `_hashVoucher` */
const VOUCHER_TYPES = {
  Asset: [
    { name: "kind",    type: "uint8"    },
    { name: "token",   type: "address"  },
    { name: "id",      type: "uint256"  },
    { name: "nonceId", type: "uint256"  },
    { name: "amount",  type: "uint256"  },
  ],
  Voucher: [
    { name: "asset",           type: "Asset"   },
    { name: "price",           type: "uint256" },
    { name: "paymentToken",    type: "address" },
    { name: "quantity",        type: "uint256" },
    { name: "maxPerWallet",    type: "uint64"  },
    { name: "startTime",       type: "uint64"  },
    { name: "endTime",         type: "uint64"  },
    { name: "royaltyReceiver", type: "address" },
    { name: "royaltyBps",      type: "uint16"  },
    { name: "salt",            type: "uint256" },
    { name: "seller",          type: "address" },
  ],
} as const;

function domain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract };
}

/* ------------------------------------------------------------------ */
/*                               Events                                */
/* ------------------------------------------------------------------ */

const EVT = {
  AskCreated    : "AskCreated(uint256,address,(uint8,address,uint256,uint256,uint256),uint256,uint256,address)",
  AskCancelled  : "AskCancelled(uint256)",
  AskFilled     : "AskFilled(uint256,address,uint256,uint256,uint256,uint256,uint256)",
  VoucherFilled : "VoucherFilled(bytes32,address,uint256,uint256,uint256,uint256,uint256)",
  FeePending    : "FeePending(address,uint256)",
  FeeFlushed    : "FeeFlushed(address,uint256)",
} as const;

/* ------------------------------------------------------------------ */
/*                              Helper                                 */
/* ------------------------------------------------------------------ */

export class MarketManagerHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;
  readonly ops     : OptionalArgs | undefined;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner, ops?: OptionalArgs) {
    this.address  = ethers.getAddress(address) as Address;
    this.runner   = runner;

    this.ops = ops;
    this.contract = new ethers.Contract(this.address, ops?.abi? [...Market.abi, ...ops.abi]: Market.abi, runner);
  }

  /* ================================================================ */
  /* 1) Deploy / Attach / Connect                                      */
  /* ================================================================ */

  /** Deploy a new MarketManager proxy and return a connected helper.
   *  Purpose: Initialize market with fee router and protocol bps.
   *  @param args   See `DeployArgs` — forwarded to `initialize(...)`.
   *  @param signer Signer used to deploy and initialize the proxy.
   *  @param opts   Optional factory options (salt, factory, gas).
   *  @returns      `{ address, receipt, helper }` for immediate use.
   */
  static async deploy(
    args: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions, "contractType" | "implABI" | "initArgs" | "signer">>,
  ): Promise<DeployResult> {
    const res = await deployViaFactory({
      contractType : Market.contractType,  // e.g., "MarketManager"
      implABI      : Market.abi,
      initArgs     : [ args.admin, args.splitter, args.bps, args.trustedForwarders ?? [] ],
      signer,
      ...(opts ?? {}),
    });

    const helper = new MarketManagerHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing MarketManager at `address`.
   *  Purpose: Bind helper to a deployed proxy for calls/transactions.
   *  @param address Target contract address.
   *  @param runner  Signer or provider context.
   *  @returns       Connected helper instance.
   */
  static attach(address: Address, runner: ContractRunner, ops?: OptionalArgs): MarketManagerHelper {
    return new MarketManagerHelper(address, runner, ops);
  }

  /** Return a new helper bound to a different signer/runner.
   *  Purpose: Swap wallet/provider without re-attaching.
   *  @param runner New signer or provider.
   *  @returns      New helper targeting the same address.
   */
  connect(runner: ContractRunner): MarketManagerHelper {
    if (runner === this.runner) return this;
    return new MarketManagerHelper(this.address, runner, this.ops);
  }

  /* ================================================================ */
  /* 2) Admin setters                                                  */
  /* ================================================================ */

  /** Update protocol fee and fee router (ADMIN_ROLE).
   *  Purpose: Change `feeBps` and set Splitter to receive fees.
   *  @param bps New fee bps (≤ 1000).
   *  @param to  New Splitter address (non-zero).
   *  @returns   Transaction receipt upon inclusion.
   */
  async setFee(bps: number, to: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.setFee(bps, to);
    return tx.wait();
  }

  /** Allow or disallow a payment token (ADMIN_ROLE).
   *  Purpose: Configure which ERC20s are acceptable as `paymentToken`.
   *  @param token   ERC20 address (address(0) == ETH).
   *  @param allowed True to allow, false to disallow.
   *  @returns       Transaction receipt upon inclusion.
   */
  async setPaymentToken(token: Address, allowed: boolean): Promise<TransactionReceipt> {
    const tx = await this.contract.setPaymentToken(token, allowed);
    return tx.wait();
  }

  /** Configure (or clear) KYC registry (ADMIN_ROLE).
   *  Purpose: When set, buyers must be whitelisted.
   *  @param registry Whitelist contract address.
   *  @returns        Transaction receipt upon inclusion.
   */
  async setWhitelist(registry: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.setWhitelist(registry);
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) On-chain Asks (create / fill / cancel)                         */
  /* ================================================================ */

  /** Create a fixed-price listing.
   *  Purpose: Escrow assets and register an `Ask` unless delegated via AgreementManager.
   *  @param asset            Asset descriptor.
   *  @param price            Price per 1 unit (token decimals or wei).
   *  @param paymentToken     Address(0)=ETH, else ERC20 (must be allowed if non-zero).
   *  @param quantity         Units to list (must be > 0).
   *  @param maxPerWallet     Per-wallet cap (0 = unlimited).
   *  @param startTime        Start timestamp (0 ⇒ now).
   *  @param endTime          End timestamp (0 = open-ended, must be > now).
   *  @param royaltyReceiver  Receiver for royalties (required when `royaltyBps > 0`).
   *  @param royaltyBps       Royalty in bps (0..10000); `feeBps + royaltyBps ≤ 10000`.
   *  @param agreement        AgreementManager address (0x0 for direct escrow).
   *  @param offerId          Offer id at AgreementManager (required if `agreement != 0`).
   *  @returns                `{ askId, receipt }` where `askId` is parsed from `AskCreated`.
   */
  async createAsk(
    asset: Asset,
    price: bigint,
    paymentToken: string,
    quantity: bigint,
    params?: {
      maxPerWallet?: number;
      startTime?: number;
      endTime?: number;
      royaltyReceiver?: string;
      royaltyBps?: number;
      agreement?: string;
      offerId?: string;
    }
  ): Promise<{ askId: bigint; receipt: ethers.TransactionReceipt }> {
    const {
      maxPerWallet    = 0,
      startTime       = 0,
      endTime         = 0,
      royaltyReceiver = ZeroAddress,
      royaltyBps      = 0,
      agreement       = ZeroAddress,   // ★ default 0x0
      offerId         = ethers.ZeroHash // ★ default 0x00…00
    } = params ?? {};

    const tx = await this.contract.createAsk(
      asset,
      price,
      paymentToken,
      quantity,
      maxPerWallet,
      startTime,
      endTime,
      royaltyReceiver,
      royaltyBps,
      agreement,
      offerId
    );
    const receipt = await tx.wait();

    // Parse `AskCreated(askId, seller, asset, qty, price, payToken)`
    let askId = 0n;
    for (const log of receipt.logs) {
      try {
        const ev = this.contract.interface.parseLog(log);
        if (ev?.name === "AskCreated") {
          askId = BigInt(ev.args?.askId ?? ev.args?.[0]);
          break;
        }
      } catch { /* ignore non-matching logs */ }
    }
    return { askId, receipt };
  }

  /** Cancel an ask (seller only).
   *  Purpose: Remove an active listing and release escrow if any.
   *  @param askId Ask id to cancel.
   *  @returns     Transaction receipt upon inclusion.
   */
  async cancelAsk(askId: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.cancelAsk(askId);
    return tx.wait();
  }

  /** Buy from an ask; auto-selects call with/without permit/investorSig.
   *  Purpose: Transfer assets seller→buyer and route payment with fee/royalty.
   *  @param askId  Ask id to fill.
   *  @param qty    Units to buy (≤ ask.quantity).
   *  @param opts   Optional settings:
   *                  - `permit`: ERC20 permit for gasless allowance set.
   *                  - `investorSig`: required when `ask.agreement != 0`.
   *                  - `value`: override ETH value; by default computed as price * qty for ETH asks.
   *  @returns      `{ receipt, totals? }` where `totals` is parsed from `AskFilled` when available.
   */
  async fillAsk(
    askId: BigNumberish,
    qty: BigNumberish,
    opts?: { permit?: PermitData; investorSig?: BytesLike; value?: bigint }
  ): Promise<{ receipt: TransactionReceipt; totals?: { totalPaid: bigint; fee: bigint; royalty: bigint; net: bigint } }> {
    const info = await this.ask(askId);
    const isETH = info.paymentToken === ZeroAddress;
    const value = opts?.value ?? (isETH ? (BigInt(info.price) * BigInt(qty)) : 0n);

    let tx;
    if (opts?.permit) {
      tx = await this.contract.fillAskWithPermit(askId, qty, opts.permit, opts?.investorSig ?? "0x", { value });
    } else if (opts?.investorSig) {
      tx = await this.contract.fillAskWithSig(askId, qty, opts.investorSig, { value });
    } else {
      // If delegated ask, investorSig is required → explicit error helps devs.
      if (info.agreement !== ZeroAddress) {
        throw new Error("This ask is delegated (agreement != 0). Pass opts.investorSig or use fillAskWithSig/fillAskWithPermit.");
      }
      tx = await this.contract.fillAsk(askId, qty, { value });
    }
    const receipt = await tx.wait();

    // Parse `AskFilled(askId, buyer, qty, totalPaid, fee, royalty, net)`
    for (const log of receipt.logs) {
      try {
        const ev = this.contract.interface.parseLog(log);
        if (ev?.name === "AskFilled") {
          const totalPaid = BigInt(ev.args?.totalPaid ?? ev.args?.[3]);
          const fee       = BigInt(ev.args?.fee       ?? ev.args?.[4]);
          const royalty   = BigInt(ev.args?.royalty   ?? ev.args?.[5]);
          const net       = BigInt(ev.args?.net       ?? ev.args?.[6]);
          return { receipt, totals: { totalPaid, fee, royalty, net } };
        }
      } catch { /* ignore */ }
    }
    return { receipt };
  }

  /* ================================================================ */
  /* 4) Vouchers (lazy listings)                                       */
  /* ================================================================ */

  /** Redeem an EIP-712 `Voucher` (lazy listing).
   *  Purpose: Seller-signed order; buyer (or relayer) executes on-chain.
   *  @param v     Voucher payload (must match Solidity struct layout).
   *  @param qty   Units to buy (supports partial fills up to `v.quantity`).
   *  @param sig   EIP-712 signature by `v.seller`.
   *  @param opts  Optional settings:
   *                 - `permit`: ERC20 permit for gasless allowance.
   *                 - `value`: override ETH value; by default computed as v.price * qty for ETH.
   *  @returns     `{ receipt, totals? }` with `VoucherFilled` amounts if emitted.
   */
  async fillVoucher(
    v: Voucher,
    qty: BigNumberish,
    sig: BytesLike,
    opts?: { permit?: PermitData; value?: bigint }
  ): Promise<{ receipt: TransactionReceipt; totals?: { totalPaid: bigint; fee: bigint; royalty: bigint; net: bigint } }> {
    const isETH = v.paymentToken === ZeroAddress;
    const value = opts?.value ?? (isETH ? (BigInt(v.price) * BigInt(qty)) : 0n);

    let tx;
    if (opts?.permit) {
      tx = await this.contract.fillVoucherWithPermit(v, qty, sig, opts.permit, { value });
    } else {
      tx = await this.contract.fillVoucher(v, qty, sig, { value });
    }
    const receipt = await tx.wait();

    // Parse `VoucherFilled(h, buyer, qty, totalPaid, fee, royalty, net)`
    for (const log of receipt.logs) {
      try {
        const ev = this.contract.interface.parseLog(log);
        if (ev?.name === "VoucherFilled") {
          const totalPaid = BigInt(ev.args?.totalPaid ?? ev.args?.[3]);
          const fee       = BigInt(ev.args?.fee       ?? ev.args?.[4]);
          const royalty   = BigInt(ev.args?.royalty   ?? ev.args?.[5]);
          const net       = BigInt(ev.args?.net       ?? ev.args?.[6]);
          return { receipt, totals: { totalPaid, fee, royalty, net } };
        }
      } catch { /* ignore */ }
    }
    return { receipt };
  }

  /** Compute the exact EIP-712 digest used by the contract for a voucher.
   *  Purpose: Pre-validate signatures or generate them off-chain.
   *  @param chainId  EVM chain id.
   *  @param voucher  `Voucher` payload.
   *  @returns        32-byte digest to be signed by `voucher.seller`.
   */
  computeVoucherDigest(chainId: number, voucher: Voucher): Bytes32 {
    return TypedDataEncoder.hash(domain(chainId, this.address), VOUCHER_TYPES as any, voucher as any) as Bytes32;
  }

  /** Sign a voucher with a signer (wallet must be `voucher.seller`).
   *  Purpose: Helper for tests and distribution tooling.
   *  @param signer   Ethers signer used to sign typed data.
   *  @param chainId  EVM chain id.
   *  @param voucher  `Voucher` payload.
   *  @returns        Hex signature suitable for `fillVoucher`.
   */
  async signVoucher(signer: ethers.Signer, chainId: number, voucher: Voucher): Promise<string> {
    // @ts-ignore: signTypedData is not strictly typed across environments
    return signer.signTypedData(domain(chainId, this.address), VOUCHER_TYPES as any, voucher as any);
  }

  /* ================================================================ */
  /* 5) Fee routing / housekeeping                                     */
  /* ================================================================ */

  /** Flush pending ERC20 fee to Splitter (nonReentrant, whenNotPaused).
   *  Purpose: Route accrued protocol fees; accrues to `pendingFee` on failure.
   *  @param token     ERC20 token address to flush (indexed in events).
   *  @param maxAmount Max amount to flush (0 = all pending).
   *  @returns         Transaction receipt upon inclusion.
   */
  async flushFees(token: Address, maxAmount: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.flushFees(token, maxAmount);
    return tx.wait();
  }

  /** Flush pending native fee to Splitter (nonReentrant, whenNotPaused).
   *  Purpose: Route accrued protocol fees in ETH; accrues to `pendingNative` on failure.
   *  @param maxAmount Max amount to flush (0 = all pending).
   *  @returns         Transaction receipt upon inclusion.
   */
  async flushNative(maxAmount: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.flushNative(maxAmount);
    return tx.wait();
  }

  /* ================================================================ */
  /* 6) Views                                                          */
  /* ================================================================ */

  /** Number of asks created (use indices `[0, asksLength)` for enumeration). */
  async asksLength(): Promise<bigint> {
    return BigInt(await this.contract.asksLength());
  }

  /** Read ask by id (full struct). */
  async ask(id: BigNumberish): Promise<Ask> {
    const a = await this.contract.ask(id);
    // Normalize tuple → typed object (defensive for ABI field names)
    return {
      seller          : ethers.getAddress(a.seller  ?? a[0]),
      asset           : {
        kind   : Number(a.asset?.kind   ?? a[1]?.kind   ?? a[1]?.[0]) as AssetKind,
        token  : ethers.getAddress(a.asset?.token  ?? a[1]?.token  ?? a[1]?.[1]),
        id     : BigInt(a.asset?.id     ?? a[1]?.id     ?? a[1]?.[2]),
        nonceId: BigInt(a.asset?.nonceId?? a[1]?.nonceId?? a[1]?.[3]),
        amount : BigInt(a.asset?.amount ?? a[1]?.amount ?? a[1]?.[4]),
      },
      price           : BigInt(a.price ?? a[2]),
      paymentToken    : ethers.getAddress(a.paymentToken ?? a[3]),
      quantity        : BigInt(a.quantity ?? a[4]),
      maxPerWallet    : Number(a.maxPerWallet ?? a[5]),
      startTime       : BigInt(a.startTime ?? a[6]),
      endTime         : BigInt(a.endTime ?? a[7]),
      royaltyReceiver : ethers.getAddress(a.royaltyReceiver ?? a[8]),
      royaltyBps      : Number(a.royaltyBps ?? a[9]),
      agreement       : ethers.getAddress(a.agreement ?? a[10]),
      offerId         : (a.offerId as Bytes32) ?? (a[11] as Bytes32),
    };
  }

  /** How many units of a voucher digest have been filled. */
  async voucherFilled(digest: Bytes32): Promise<bigint> {
    return BigInt(await this.contract.voucherFilled(digest));
  }

  /** Protocol fee bps (public variable). */
  async feeBps(): Promise<number> { return Number(await this.contract.feeBps()); }

  /** Current Splitter address (public variable). */
  async splitter(): Promise<Address> { return (await this.contract.splitter()) as Address; }

  /** Current KYC whitelist registry (0x0 if unset). */
  async kyc(): Promise<Address> { return (await this.contract.kyc()) as Address; }

  /** Whether an ERC20 is allowed as a payment token (address(0) denotes ETH). */
  async isPaymentTokenAllowed(token: Address): Promise<boolean> {
    return this.contract.allowedPaymentToken(token) as Promise<boolean>;
  }

  /** Pending ERC20 protocol fee for a given token. */
  async pendingFee(token: Address): Promise<bigint> {
    return BigInt(await this.contract.pendingFee(token));
  }

  /** Pending native (ETH) protocol fee. */
  async pendingNative(): Promise<bigint> {
    return BigInt(await this.contract.pendingNative());
  }

  /** ERC165 support check (via AccessControlUpgradeable). */
  async supportsInterface(iid: BytesLike): Promise<boolean> {
    return this.contract.supportsInterface(iid) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 7) Pause                                                          */
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

  /** Query `AskCreated(askId, seller, asset, qty, price, payToken)` events. */
  async queryAskCreated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.AskCreated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `AskCancelled(askId)` events. */
  async queryAskCancelled(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.AskCancelled);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `AskFilled(askId, buyer, qty, totalPaid, fee, royalty, net)` events. */
  async queryAskFilled(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.AskFilled);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `VoucherFilled(h, buyer, qty, totalPaid, fee, royalty, net)` events. */
  async queryVoucherFilled(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.VoucherFilled);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `FeePending(token, amount)` events. */
  async queryFeePending(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.FeePending);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `FeeFlushed(token, amount)` events. */
  async queryFeeFlushed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.FeeFlushed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /* ================================================================ */
  /* 9) Asset helpers (object builders)                                */
  /* ================================================================ */

  /** Build an ERC-20 asset descriptor. */
  static assetERC20(token: Address, amountPerUnit: bigint): Asset {
    return { kind: AssetKind.ERC20, token, id: 0n, nonceId: 0n, amount: amountPerUnit };
  }

  /** Build an ERC-721 asset descriptor. */
  static assetERC721(token: Address, tokenId: bigint): Asset {
    return { kind: AssetKind.ERC721, token, id: tokenId, nonceId: 0n, amount: 1n };
  }

  /** Build an ERC-1155 asset descriptor. */
  static assetERC1155(token: Address, id: bigint, amountPerUnit: bigint): Asset {
    return { kind: AssetKind.ERC1155, token, id, nonceId: 0n, amount: amountPerUnit };
  }

  /** Build a BOND asset descriptor (ERC-3475-like). */
  static assetBond(token: Address, classId: bigint, nonceId: bigint, unitsPerTicket: bigint): Asset {
    return { kind: AssetKind.BOND, token, id: classId, nonceId, amount: unitsPerTicket };
  }
}

export default MarketManagerHelper;
