/* ------------------------------------------------------------------ */
/*  AgreementManagerHelper — Two-step offer & optional escrow         */
/* ------------------------------------------------------------------ */
/*  Overview
    - Mirrors AgreementManagerUpgradeable.sol (UUPS + ERC2771 + Roles + Pausable).
    - Flow:
        1) Issuer signs an EIP-712 Offer and calls `offer(...)` (escrow if tokenAddress != 0).
        2) Investor (or delegated market) calls `acceptOffer(offerId, investorSig)`.
        3) Alternatively, investor can `rejectOffer(...)` or issuer can `cancelOffer(...)`.
    - Includes:
        * deploy (proxy via factory), attach, connect
        * writes: offer, cancelOffer, acceptOffer, rejectOffer, raiseDispute, setDisputeStatus, pause, unpause
        * views : getOffer, getDispute, contractType/Version, nextNonce, usedNonces, currentNonce, isSettled
        * EIP-712 utils: build/sign/verify offer, computeOfferId (matches on-chain keccak), event queries */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  TransactionReceipt,
  BytesLike,
  BigNumberish,
  TypedDataEncoder,
  ZeroAddress,
  SignatureLike,
} from "ethers";

import { AgreementManager as Agreement } from "../contracts/AgreementManager";
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address  = string;
export type Bytes32  = string;

/** Deploy-time arguments mapped to AgreementManager.initialize(...) */
export interface DeployArgs {
  /** DEFAULT_ADMIN_ROLE holder */
  admin: Address;
  /** ERC-2771 trusted forwarders (can be empty) */
  trustedForwarders?: readonly Address[];
}

/** Result of deployment via factory (uses `res.address`) */
export interface DeployResult {
  /** Proxy address */
  address: Address;
  /** Deployment/initialize receipt */
  receipt: TransactionReceipt;
  /** Connected helper */
  helper: AgreementManagerHelper;
}

/** Offer status enum — MUST match Solidity order */
export enum OfferStatus {
  None      = 0,
  Offered   = 1,
  Accepted  = 2,
  Rejected  = 3,
  Cancelled = 4,
}

/** Dispute status enum — MUST match Solidity order */
export enum DisputeStatus {
  None         = 0,
  Raised       = 1,
  Acknowledged = 2,
  Resolved     = 3,
  Rejected     = 4,
}

/** Canonical on-chain Offer struct (see .sol) */
export interface OfferStruct {
  issuer:       Address;   // offer maker (msg.sender at creation)
  investor:     Address;   // intended counterparty
  tokenAddress: Address;   // asset address (address(0) ⇒ escrowless)
  partition:    Bytes32;   // ERC-1400 partition (ignored for others)
  tokenId:      bigint;    // ERC721/1155 id (0 for fungibles)
  classId:      bigint;    // ERC-3475 class (0 for others)
  nonceId:      bigint;    // ERC-3475 nonce  (0 for others)
  amount:       bigint;    // amount/units for ERC20/1400/1155/3475 (1 for ERC721)
  documentHash: Bytes32;   // keccak256 of off-chain doc (or any 32B hash)
  documentURI:  string;    // URI string (IPFS/HTTPS)
  expiry:       bigint;    // unix seconds
  nonce:        bigint;    // issuer-scoped nonce (replay protection)
  delegatedTo:  Address;   // optional delegated market/agent
  issuerSig:    string;    // issuer EIP-712 signature (bytes)
  status:       OfferStatus;
}

/** Minimal dispute struct (see .sol) */
export interface DisputeStruct {
  claimant:     Address;
  offerId:      Bytes32;
  evidenceURI:  string;
  status:       DisputeStatus;
  createdAt:    bigint;
}

/** Arguments for creating an offer (issuer-signed) */
export interface OfferArgs {
  /** Intended counterparty (investor) */
  investor: Address;
  /** Asset address (address(0) for escrowless) */
  tokenAddress: Address;
  /** ERC-1400 partition (0x00…00 for others) */
  partition: Bytes32;
  /** ERC721/1155 id (0 for fungibles) */
  tokenId: BigNumberish;
  /** Amount/units for ERC20/1400/1155/3475 (1 for ERC721) */
  amount: BigNumberish;
  /** ERC-3475 class id (0 for others) */
  classId: BigNumberish;
  /** ERC-3475 nonce id (0 for others) */
  nonceId: BigNumberish;
  /** Off-chain document hash (bytes32) */
  documentHash: Bytes32;
  /** Off-chain document URI (string) */
  documentURI: string;
  /** Expiry (unix seconds, ≥ now) */
  expiry: BigNumberish;
  /** Issuer-scoped nonce (must be unused) */
  nonce: BigNumberish;
  /** EIP-712 signature by the issuer over the fields above */
  issuerSig: BytesLike;
  /** Optional delegated executor; if set, only this address can call acceptOffer */
  delegatedTo?: Address;
}

/* ------------------------------------------------------------------ */
/*                         EIP-712 Definitions                         */
/* ------------------------------------------------------------------ */

const EIP712_NAME    = "AgreementManager";
const EIP712_VERSION = "1";

/** EIP-712 typed struct used by both issuer and investor */
const OFFER_TYPES = {
  Offer: [
    { name: "issuer",       type: "address" },
    { name: "investor",     type: "address" },
    { name: "tokenAddress", type: "address" },
    { name: "partition",    type: "bytes32" },
    { name: "tokenId",      type: "uint256" },
    { name: "amount",       type: "uint256" },
    { name: "classId",      type: "uint256" },
    { name: "nonceId",      type: "uint256" },
    { name: "documentHash", type: "bytes32" },
    { name: "documentURI",  type: "string"  },
    { name: "expiry",       type: "uint256" },
    { name: "nonce",        type: "uint256" },
  ],
} as const;

function domain(chainId: number, verifyingContract: Address) {
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract };
}

/* ------------------------------------------------------------------ */
/*                               Events                                */
/* ------------------------------------------------------------------ */

const EVT = {
  OfferCreated     : "OfferCreated(bytes32,address,address)",
  OfferCancelled   : "OfferCancelled(bytes32)",
  OfferSettled     : "OfferSettled(bytes32,address,address,address,bytes32,uint256,uint256,uint256,uint256,bytes32,string,uint256,uint256,bytes,bytes)",
  OfferRejected    : "OfferRejected(bytes32)",
  OfferCleanedUp   : "OfferCleanedUp(bytes32)",
  DisputeRaised    : "DisputeRaised(bytes32,bytes32,address,string)",
  DisputeStatusSet : "DisputeStatusChanged(bytes32,uint8)",
} as const;

/* ------------------------------------------------------------------ */
/*                              Helper                                 */
/* ------------------------------------------------------------------ */

export class AgreementManagerHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner) {
    this.address  = ethers.getAddress(address) as Address;
    this.runner   = runner;
    this.contract = new ethers.Contract(this.address, Agreement.abi as InterfaceAbi, runner);
  }

  /* ================================================================ */
  /* 1) Deploy / Attach / Connect                                      */
  /* ================================================================ */

  /** Deploy a new AgreementManager proxy and return a connected helper.
   *  Purpose: Initialize a two-step offer manager with optional escrow and meta-tx.
   *  @param args   `{ admin, trustedForwarders }` forwarded to `initialize`.
   *  @param signer Deployer signer.
   *  @param opts   Optional factory options (salt, factory address, gas settings).
   *  @returns      `{ address, receipt, helper }` for immediate use.
   */
  static async deploy(
    args: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions, "contractType" | "implABI" | "initArgs" | "signer">>,
  ): Promise<DeployResult> {
    const res = await deployViaFactory({
      contractType : Agreement.contractType, // e.g., "AgreementManager"
      implABI      : Agreement.abi,
      initArgs     : [ args.admin, args.trustedForwarders ?? [] ],
      signer,
      ...(opts ?? {}),
    });
    const helper = new AgreementManagerHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing AgreementManager at `address`.
   *  Purpose: Bind helper to a deployed proxy for calls and transactions.
   *  @param address Target contract address.
   *  @param runner  Signer or provider context.
   *  @returns       Connected helper instance.
   */
  static attach(address: Address, runner: ContractRunner | ethers.Signer): AgreementManagerHelper {
    return new AgreementManagerHelper(address, runner);
  }

  /** Return a new helper bound to a different signer/runner.
   *  Purpose: Swap wallet/provider without re-attaching.
   *  @param runner New signer or provider.
   *  @returns      New helper instance pointing to the same contract.
   */
  connect(runner: ContractRunner | ethers.Signer): AgreementManagerHelper {
    if (runner === this.runner) return this;
    return new AgreementManagerHelper(this.address, runner);
  }

  /* ================================================================ */
  /* 2) Offer lifecycle                                                */
  /* ================================================================ */

  /** Create an offer and (optionally) escrow assets into the contract.
   *  Purpose: Persist an issuer-signed offer; escrow occurs if `tokenAddress != 0x0`.
   *  @param a            Offer arguments (see `OfferArgs`).
   *  @returns            `{ offerId, receipt }` where `offerId` is the deterministic id used on-chain.
   *
   *  Notes:
   *  - Issuer is `msg.sender` of this transaction and MUST match the signer of `issuerSig`.
   *  - When `tokenAddress == 0x0` (escrowless), all of {tokenId, amount, classId, nonceId} MUST be zero.
   *  - Reverts on expired offers, used nonce, bad signature, or duplicate `offerId`.
   *
   *  Solidity:
   *    function offer(
   *      address investor, address tokenAddress, bytes32 partition,
   *      uint256 tokenId, uint256 amount, uint256 classId, uint256 nonceId,
   *      bytes32 documentHash, string documentURI,
   *      uint256 expiry, uint256 nonce,
   *      bytes issuerSig, address delegatedTo
   *    ) external;
   */
  async offer(a: OfferArgs): Promise<{ offerId: Bytes32; receipt: TransactionReceipt }> {
    const signer = this.runner as ethers.Signer;
    const issuer = ethers.getAddress(await signer.getAddress()) as Address;

    // Compute deterministic offerId (must match on-chain keccak256(abi.encode(...))).
    const offerId = AgreementManagerHelper.computeOfferId({
      issuer,
      investor    : a.investor,
      tokenAddress: a.tokenAddress,
      partition   : a.partition,
      tokenId     : a.tokenId,
      amount      : a.amount,
      classId     : a.classId,
      nonceId     : a.nonceId,
      documentHash: a.documentHash,
      documentURI : a.documentURI,
      expiry      : a.expiry,
      nonce       : a.nonce,
    });

    // Submit the offer
    const tx = await this.contract.offer(
      a.investor,
      a.tokenAddress,
      a.partition,
      a.tokenId,
      a.amount,
      a.classId,
      a.nonceId,
      a.documentHash,
      a.documentURI,
      a.expiry,
      a.nonce,
      a.issuerSig,
      a.delegatedTo ?? ZeroAddress
    );
    const receipt = await tx.wait();
    return { offerId, receipt };
  }

  /** Cancel an offered (non-expired) offer; issuer only.
   *  Purpose: Return escrow to issuer and remove the offer.
   *  @param offerId  Target offer id.
   *  @returns        Transaction receipt upon inclusion.
   *
   *  Solidity: function cancelOffer(bytes32 offerId) external;
   */
  async cancelOffer(offerId: Bytes32): Promise<TransactionReceipt> {
    const tx = await this.contract.cancelOffer(offerId);
    return tx.wait();
  }

  /** Accept an offered (non-expired) offer as investor or delegated market.
   *  Purpose: Transfer escrow to investor and finalize agreement.
   *  @param offerId      Target offer id.
   *  @param investorSig  Investor EIP-712 signature over the same Offer struct.
   *  @returns            Transaction receipt upon inclusion.
   *
   *  Solidity: function acceptOffer(bytes32 offerId, bytes investorSig) external;
   */
  async acceptOffer(offerId: Bytes32, investorSig: BytesLike): Promise<TransactionReceipt> {
    const tx = await this.contract.acceptOffer(offerId, investorSig);
    return tx.wait();
  }

  /** Reject an offered (non-expired) offer; investor only.
   *  Purpose: Return escrow to issuer and delete the offer.
   *  @param offerId  Target offer id.
   *  @returns        Transaction receipt upon inclusion.
   *
   *  Solidity: function rejectOffer(bytes32 offerId) external;
   */
  async rejectOffer(offerId: Bytes32): Promise<TransactionReceipt> {
    const tx = await this.contract.rejectOffer(offerId);
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Disputes                                                       */
  /* ================================================================ */

  /** Raise a dispute record (no fund movement).
   *  Purpose: Persist a dispute with an evidence pointer.
   *  @param offerId     Optional related offer id (0x0 if none).
   *  @param evidenceURI IPFS/HTTPS evidence.
   *  @returns           `{ disputeId, receipt }` (id is keccak(sender, now, offerId, evidenceURI)).
   *
   *  Solidity: function raiseDispute(bytes32 offerId, string evidenceURI) external;
   */
  async raiseDispute(offerId: Bytes32, evidenceURI: string): Promise<{ disputeId: Bytes32; receipt: TransactionReceipt }> {
    const tx = await this.contract.raiseDispute(offerId, evidenceURI);
    const rc = await tx.wait();
    // Recover disputeId from event or recompute locally like the contract
    let disputeId: Bytes32 | null = null;
    for (const log of rc.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed?.name === "DisputeRaised") {
          disputeId = parsed.args?.disputeId as Bytes32;
          break;
        }
      } catch { /* ignore non-matching logs */ }
    }
    // Fallback: recompute ~ not exact timestamp; so only return when parsed.
    return { disputeId: (disputeId ?? ("0x".padEnd(66, "0") as Bytes32)), receipt: rc };
  }

  /** Set dispute status (GUARDIAN_ROLE).
   *  Purpose: Administrative status transition (no fund movement).
   *  @param id         Dispute id.
   *  @param newStatus  One of Acknowledged/Resolved/Rejected.
   *  @returns          Transaction receipt upon inclusion.
   *
   *  Solidity: function setDisputeStatus(bytes32 id, DisputeStatus newStatus) external;
   */
  async setDisputeStatus(id: Bytes32, newStatus: DisputeStatus): Promise<TransactionReceipt> {
    const tx = await this.contract.setDisputeStatus(id, newStatus);
    return tx.wait();
  }

  /* ================================================================ */
  /* 4) Views                                                          */
  /* ================================================================ */

  /** Get a stored Offer by id. */
  async getOffer(id: Bytes32): Promise<OfferStruct> {
    const o = await this.contract.getOffer(id);
    return {
      issuer      : ethers.getAddress(o.issuer ?? o[0]) as Address,
      investor    : ethers.getAddress(o.investor ?? o[1]) as Address,
      tokenAddress: ethers.getAddress(o.tokenAddress ?? o[2]) as Address,
      partition   : (o.partition ?? o[3]) as Bytes32,
      tokenId     : BigInt(o.tokenId ?? o[4]),
      classId     : BigInt(o.classId ?? o[5]),
      nonceId     : BigInt(o.nonceId ?? o[6]),
      amount      : BigInt(o.amount ?? o[7]),
      documentHash: (o.documentHash ?? o[8]) as Bytes32,
      documentURI : (o.documentURI ?? o[9]) as string,
      expiry      : BigInt(o.expiry ?? o[10]),
      nonce       : BigInt(o.nonce ?? o[11]),
      delegatedTo : ethers.getAddress(o.delegatedTo ?? o[12]) as Address,
      issuerSig   : (o.issuerSig ?? o[13]) as string,
      status      : Number(o.status ?? o[14]) as OfferStatus,
    };
  }

  /** Read a stored Dispute by id. */
  async getDispute(id: Bytes32): Promise<DisputeStruct> {
    const d = await this.contract.getDispute(id);
    return {
      claimant   : ethers.getAddress(d.claimant ?? d[0]) as Address,
      offerId    : (d.offerId ?? d[1]) as Bytes32,
      evidenceURI: (d.evidenceURI ?? d[2]) as string,
      status     : Number(d.status ?? d[3]) as DisputeStatus,
      createdAt  : BigInt(d.createdAt ?? d[4]),
    };
  }

  /** Next nonce value expected to be unused for an issuer. */
  async nextNonce(issuer: Address): Promise<bigint> {
    return BigInt(await this.contract.nextNonce(issuer));
  }

  /** Used-nonce check (public mapping). */
  async usedNonces(issuer: Address, nonce: BigNumberish): Promise<boolean> {
    return this.contract.usedNonces(issuer, nonce) as Promise<boolean>;
  }

  /** Current nonce counter (public mapping; equals `nextNonce`). */
  async currentNonce(issuer: Address): Promise<bigint> {
    return BigInt(await this.contract.currentNonce(issuer));
  }

  /** Settlement flag (true after successful acceptance). */
  async isSettled(id: Bytes32): Promise<boolean> {
    return this.contract.isSettled(id) as Promise<boolean>;
  }

  /** Contract type string ("AgreementManager"). */
  async contractType(): Promise<string> {
    return this.contract.contractType() as Promise<string>;
  }

  /** Contract semantic version ("1"). */
  async contractVersion(): Promise<string> {
    return this.contract.contractVersion() as Promise<string>;
  }

  /** ERC-2771 meta-tx forwarder check. */
  async isTrustedForwarder(fwd: Address): Promise<boolean> {
    return this.contract.isTrustedForwarder(fwd) as Promise<boolean>;
  }

  /** ERC-165 support check. */
  async supportsInterface(iid: BytesLike): Promise<boolean> {
    return this.contract.supportsInterface(iid) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 5) Pausable                                                       */
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
  /* 6) EIP-712 Utilities                                              */
  /* ================================================================ */

  /** Compute deterministic `offerId` exactly as the contract does (keccak256(abi.encode(...))).
   *  Purpose: Pre-compute ids client-side and reconcile with events/storage.
   *  @param x  Minimal fields needed for id derivation. `issuer` is msg.sender at `offer(...)`.
   *  @returns  32-byte id (hex string).
   */
  static computeOfferId(x: {
    issuer: Address;
    investor: Address;
    tokenAddress: Address;
    partition: Bytes32;
    tokenId: BigNumberish;
    amount: BigNumberish;
    classId: BigNumberish;
    nonceId: BigNumberish;
    documentHash: Bytes32;
    documentURI: string;
    expiry: BigNumberish;
    nonce: BigNumberish;
  }): Bytes32 {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    // contract uses keccak256(bytes(documentURI)) inside abi.encode
    const uriHash = ethers.keccak256(ethers.toUtf8Bytes(x.documentURI));
    const encoded = coder.encode(
      [
        "bytes1","address",     // 0x01, issuer
        "bytes1","address",     // 0x02, investor
        "bytes1","address",     // 0x03, tokenAddress
        "bytes32","uint256","uint256","uint256", // partition, tokenId, amount, classId
        "uint256","bytes32","bytes32","uint256","uint256" // nonceId, documentHash, keccak(documentURI), expiry, nonce
      ],
      [
        "0x01", x.issuer,
        "0x02", x.investor,
        "0x03", x.tokenAddress,
        x.partition, x.tokenId, x.amount, x.classId,
        x.nonceId, x.documentHash, uriHash, x.expiry, x.nonce
      ]
    );
    return ethers.keccak256(encoded) as Bytes32;
  }

  /** Build the EIP-712 digest used by both issuer and investor for a given offer.
   *  Purpose: Pre-validate signatures or generate them off-chain.
   *  @param chainId EVM chain id.
   *  @param verifyingContract AgreementManager address (this.address).
   *  @param offer Full typed payload (same layout for issuer & investor).
   *  @returns     32-byte digest to be signed / recovered.
   */
  static buildOfferDigest(
    chainId: number,
    verifyingContract: Address,
    offer: {
      issuer: Address; investor: Address; tokenAddress: Address; partition: Bytes32;
      tokenId: BigNumberish; amount: BigNumberish; classId: BigNumberish; nonceId: BigNumberish;
      documentHash: Bytes32; documentURI: string; expiry: BigNumberish; nonce: BigNumberish;
    }
  ): Bytes32 {
    return TypedDataEncoder.hash(domain(chainId, verifyingContract), OFFER_TYPES as any, offer as any) as Bytes32;
  }

  /** Sign an Offer (issuer or investor).
   *  Purpose: Helper for tests/tools to produce correct EIP-712 signatures.
   *  @param signer   Ethers signer used to sign typed data (must equal `offer.issuer` or `offer.investor`).
   *  @param chainId  EVM chain id.
   *  @param offer    Offer payload (fields as in `OFFER_TYPES.Offer`).
   *  @returns        Hex signature (0x…).
   */
  static async signOffer(
    signer: ethers.Signer,
    chainId: number,
    verifyingContract: Address,
    offer: {
      issuer: Address; investor: Address; tokenAddress: Address; partition: Bytes32;
      tokenId: BigNumberish; amount: BigNumberish; classId: BigNumberish; nonceId: BigNumberish;
      documentHash: Bytes32; documentURI: string; expiry: BigNumberish; nonce: BigNumberish;
    }
  ): Promise<string> {
    // @ts-ignore — signTypedData types vary across environments
    return signer.signTypedData(domain(chainId, verifyingContract), OFFER_TYPES as any, offer as any);
  }

  /** Recover signer from a provided signature over an offer payload. */
  static recoverOfferSigner(
    chainId: number,
    verifyingContract: Address,
    offer: {
      issuer: Address; investor: Address; tokenAddress: Address; partition: Bytes32;
      tokenId: BigNumberish; amount: BigNumberish; classId: BigNumberish; nonceId: BigNumberish;
      documentHash: Bytes32; documentURI: string; expiry: BigNumberish; nonce: BigNumberish;
    },
    sig: SignatureLike
  ): Address {
    const digest = AgreementManagerHelper.buildOfferDigest(chainId, verifyingContract, offer);
    return ethers.recoverAddress(digest, sig) as Address;
  }

  /* ================================================================ */
  /* 7) Event queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `OfferCreated(offerId, issuer, investor)` events. */
  async queryOfferCreated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.OfferCreated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `OfferCancelled(offerId)` events. */
  async queryOfferCancelled(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.OfferCancelled);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `OfferSettled(...)` events. */
  async queryOfferSettled(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.OfferSettled);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `OfferRejected(offerId)` events. */
  async queryOfferRejected(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.OfferRejected);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `OfferCleanedUp(offerId)` events. */
  async queryOfferCleanedUp(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.OfferCleanedUp);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `DisputeRaised(disputeId, offerId, claimant, evidenceURI)` events. */
  async queryDisputeRaised(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.DisputeRaised);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `DisputeStatusChanged(disputeId, newStatus)` events. */
  async queryDisputeStatusChanged(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.DisputeStatusSet);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }
}

export default AgreementManagerHelper;
