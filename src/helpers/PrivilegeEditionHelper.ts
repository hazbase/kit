/* ------------------------------------------------------------------ */
/*  PrivilegeEditionHelper — ERC-1155 Privilege/Reward Editions        */
/* ------------------------------------------------------------------ */
/*  Overview
    - Mirrors PrivilegeEdition.sol (ERC1155 + ERC2981 + EIP-712 + Votes + UUPS + ERC2771).
    - Provides typed helpers for:
        * deploy (proxy via factory), attach, connect
        * admin: setDefaultRoyalty / deleteDefaultRoyalty / lockSupply / setTier / setWhitelist / pause / unpause
        * minting: mint, redeemVoucher (EIP-712)
        * user actions: redeem, batchRedeem, permitForAll, sweepExpired(From)
        * views: contractType/Version/URI, uri(id), totalSupply, totalMinted, maxSupply, rewardTypeOf,
                 whitelist, supportsInterface, soulbound
        * EIP-712 utilities: computeVoucherDigest, signVoucher
        * event queries: MetadataUpdate, RewardRedeemed, TransferSingle, TransferBatch, ApprovalForAll   */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  TransactionReceipt,
  BytesLike,
} from "ethers";

import { PrivilegeEdition } from "../contracts/PrivilegeEdition";
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;
export type Bytes32 = string;

/** Deploy-time arguments (forwarded to initialize) */
export interface DeployArgs {
  /** Base URI used by ERC1155 (e.g., "ipfs://.../{id}.json") */
  baseURI: string;
  /** DEFAULT_ADMIN_ROLE holder (also receives MINTER/PAUSER/etc via RolesCommon) */
  admin: Address;
  /** ERC-2771 trusted forwarders (can be empty) */
  trustedForwarders?: readonly Address[];
  /** Default royalty receiver (ERC-2981) */
  royaltyReceiver: Address;
  /** Default royalty fee in basis points (0..10000) */
  royaltyFeeBps: number;
}

/** Result of deployment via factory (use `res.address`) */
export interface DeployResult {
  address: Address;                 // Proxy address
  receipt: TransactionReceipt;      // Deployment/initialize tx receipt
  helper : PrivilegeEditionHelper;  // Connected helper
}

/** Voucher struct for lazy minting (must match Solidity field order & types) */
export interface MintVoucher {
  /** Token id to mint */
  id: bigint | number;
  /** Amount to mint (per ERC1155 semantics) */
  amount: bigint | number;
  /** Per-id metadata URI (overrides baseURI when non-empty) */
  uri: string;
  /** Voting tier factor (0..255) used by VotesUpgradeable */
  tier: number;
  /** Unix seconds when this edition expires (transfer/burn handling on-chain) */
  expiresAt: bigint | number;
  /** Unix seconds (inclusive) until which the voucher is valid */
  validUntil: bigint | number;
  /** Issuer-chosen unique nonce (anti-replay, tracked on chain) */
  nonce: bigint | number;
  /** Signer address (must hold MINTER_ROLE) */
  issuer: Address;
  /** Recipient; if zero, contract will use _msgSender() */
  to: Address;
}

/* ------------------------------------------------------------------ */
/*                         EIP-712 Definitions                         */
/* ------------------------------------------------------------------ */

/** EIP-712 domain name/version used by the contract initializer */
export const EIP712_NAME = "PrivilegeEdition";
export const EIP712_VERSION = "1";

/** Typed struct used by on-chain `redeemVoucher` */
const VOUCHER_TYPES = {
  MintVoucher: [
    { name: "id",         type: "uint256" },
    { name: "amount",     type: "uint256" },
    { name: "uri",        type: "string"  },
    { name: "tier",       type: "uint8"   },
    { name: "expiresAt",  type: "uint64"  },
    { name: "validUntil", type: "uint64"  },
    { name: "nonce",      type: "uint256" },
    { name: "issuer",     type: "address" },
    { name: "to",         type: "address" },
  ],
} as const;

/* ------------------------------------------------------------------ */
/*                               Events                                */
/* ------------------------------------------------------------------ */

const EVT = {
  MetadataUpdate : "MetadataUpdate(uint256)",
  RewardRedeemed : "RewardRedeemed(address,uint256,uint256)",
  TransferSingle : "TransferSingle(address,address,address,uint256,uint256)",
  TransferBatch  : "TransferBatch(address,address,address,uint256[],uint256[])",
  ApprovalForAll : "ApprovalForAll(address,address,bool)",
} as const;

/* ------------------------------------------------------------------ */
/*                              Helper                                 */
/* ------------------------------------------------------------------ */

export class PrivilegeEditionHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner) {
    this.address  = ethers.getAddress(address) as Address;
    this.runner   = runner;
    this.contract = new ethers.Contract(this.address, PrivilegeEdition.abi as InterfaceAbi, runner);
  }

  /* ================================================================ */
  /* 1) Deploy / Attach / Connect                                      */
  /* ================================================================ */

  /** Deploy a new PrivilegeEdition proxy and return a connected helper.
   *  Purpose: Initialize an ERC-1155 collection with royalties, EIP-712, meta-tx, and votes.
   *  @param args   `{ baseURI, admin, trustedForwarders, royaltyReceiver, royaltyFeeBps }` forwarded to `initialize`.
   *  @param signer Deployer signer.
   *  @param opts   Optional factory options (salt, factory address, gas).
   *  @returns      `{ address, receipt, helper }` for immediate use.
   */
  static async deploy(
    args: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions, "contractType" | "implABI" | "initArgs" | "signer">>,
  ): Promise<DeployResult> {
    const res = await deployViaFactory({
      contractType : PrivilegeEdition.contractType, // e.g., "PrivilegeEdition"
      implABI      : PrivilegeEdition.abi,
      initArgs     : [
        args.baseURI,
        args.admin,
        args.trustedForwarders ?? [],
        args.royaltyReceiver,
        args.royaltyFeeBps,
      ],
      signer,
      ...(opts ?? {}),
    });

    const helper = new PrivilegeEditionHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing PrivilegeEdition at `address`.
   *  Purpose: Bind helper to a deployed proxy for calls/transactions.
   *  @param address Target contract address.
   *  @param runner  Signer or provider context.
   *  @returns       Connected helper instance.
   */
  static attach(address: Address, runner: ContractRunner | ethers.Signer): PrivilegeEditionHelper {
    return new PrivilegeEditionHelper(address, runner);
  }

  /** Return a new helper bound to a different signer/runner.
   *  Purpose: Swap wallet/provider without re-attaching.
   *  @param runner New signer or provider.
   *  @returns      New helper targeting the same address.
   */
  connect(runner: ContractRunner | ethers.Signer): PrivilegeEditionHelper {
    if (runner === this.runner) return this;
    return new PrivilegeEditionHelper(this.address, runner);
  }

  /* ================================================================ */
  /* 2) Admin / Governance                                             */
  /* ================================================================ */

  /** Set default royalty parameters (ERC-2981).
   *  Purpose: Configure marketplace royalty distribution.
   *  @param receiver Royalty receiver address.
   *  @param feeBps   Fee in basis points (0..10000).
   *  @returns        Transaction receipt upon inclusion.
   */
  async setDefaultRoyalty(receiver: Address, feeBps: number): Promise<TransactionReceipt> {
    const tx = await this.contract.setDefaultRoyalty(receiver, feeBps);
    return tx.wait();
  }

  /** Delete default royalty parameters (ERC-2981).
   *  Purpose: Remove royalty info; per-id settings, if any, remain.
   *  @returns Transaction receipt upon inclusion.
   */
  async deleteDefaultRoyalty(): Promise<TransactionReceipt> {
    const tx = await this.contract.deleteDefaultRoyalty();
    return tx.wait();
  }

  /** Lock (cap) total supply for a given id.
   *  Purpose: Enforce maximum mintable units; 0 means unlocked/unlimited before locking.
   *  @param id   Token id to cap.
   *  @param cap  Maximum supply to allow (must be ≥ current minted).
   *  @returns    Transaction receipt upon inclusion.
   */
  async lockSupply(id: bigint | number, cap: bigint | number): Promise<TransactionReceipt> {
    const tx = await this.contract.lockSupply(id, cap);
    return tx.wait();
  }

  /** Set voting tier for an id before any mint has occurred.
   *  Purpose: Adjust per-id voting weight factor (0..255).
   *  @param id      Token id.
   *  @param newTier Tier value (0..255); reverts if already minted.
   *  @returns       Transaction receipt upon inclusion.
   */
  async setTier(id: bigint | number, newTier: number): Promise<TransactionReceipt> {
    const tx = await this.contract.setTier(id, newTier);
    return tx.wait();
  }

  /** Configure (or clear) the whitelist registry.
   *  Purpose: When set, transfers require both sender and recipient to be whitelisted.
   *  @param registry Whitelist contract address (0x0 to disable).
   *  @returns        Transaction receipt upon inclusion.
   */
  async setWhitelist(registry: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.setWhitelist(registry);
    return tx.wait();
  }

  /** Pause state-changing entrypoints (PAUSER_ROLE).
   *  Purpose: Emergency stop for mints/transfers/redeems.
   *  @returns Transaction receipt upon inclusion.
   */
  async pause(): Promise<TransactionReceipt> {
    const tx = await this.contract.pause();
    return tx.wait();
  }

  /** Unpause state-changing entrypoints (PAUSER_ROLE).
   *  Purpose: Resume operations after pause.
   *  @returns Transaction receipt upon inclusion.
   */
  async unpause(): Promise<TransactionReceipt> {
    const tx = await this.contract.unpause();
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Minting / Lazy Mint                                            */
  /* ================================================================ */

  /** Mint directly (MINTER_ROLE).
   *  Purpose: Create/mint an edition and set its metadata & reward type.
   *  @param to     Recipient address.
   *  @param id     Token id to mint.
   *  @param amt    Amount to mint.
   *  @param uri    Per-id metadata URI (empty string to use baseURI).
   *  @param tier   Voting tier factor (0..255).
   *  @param exp    Expiry timestamp (unix seconds).
   *  @param rType  Arbitrary reward type flag to associate with `id`.
   *  @returns      Transaction receipt upon inclusion.
   */
  async mint(
    to: Address,
    id: bigint | number,
    amt: bigint | number,
    uri: string,
    tier: number,
    exp: bigint | number,
    rType: bigint | number
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.mint(to, id, amt, uri, tier, exp, rType);
    return tx.wait();
  }

  /** Redeem an EIP-712 MintVoucher (lazy mint) (MINTER signature required).
   *  Purpose: Gas-efficient distribution; issuer signs off-chain, user (or relayer) submits on-chain.
   *  @param voucher MintVoucher payload (fields must match Solidity struct).
   *  @param sig     EIP-712 signature by `voucher.issuer`.
   *  @param rType   Reward type to associate with `voucher.id`.
   *  @returns       Transaction receipt upon inclusion.
   */
  async redeemVoucher(
    voucher: MintVoucher,
    sig: BytesLike,
    rType: bigint | number
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.redeemVoucher(voucher, sig, rType);
    return tx.wait();
  }

  /* ================================================================ */
  /* 4) User actions (redeem / approvals / sweeping)                   */
  /* ================================================================ */

  /** Redeem (burn) tokens for rewards.
   *  Purpose: Holder burns `amount` of `id`; downstream system credits the off-chain reward.
   *  @param from   Token holder (must be caller or approved operator).
   *  @param id     Token id to redeem.
   *  @param amount Amount to burn.
   *  @returns      Transaction receipt upon inclusion.
   */
  async redeem(from: Address, id: bigint | number, amount: bigint | number): Promise<TransactionReceipt> {
    const tx = await this.contract.redeem(from, id, amount);
    return tx.wait();
  }

  /** Batch version of `redeem`.
   *  Purpose: Burn multiple ids in a single transaction.
   *  @param from     Token holder (caller or approved).
   *  @param ids      Token ids to burn (array).
   *  @param amounts  Amounts per id (same length as `ids`).
   *  @returns        Transaction receipt upon inclusion.
   */
  async batchRedeem(
    from: Address,
    ids: readonly (bigint | number)[],
    amounts: readonly (bigint | number)[]
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.batchRedeem(from, ids, amounts);
    return tx.wait();
  }

  /** Permit-for-all (EIP-712) — gasless operator approval.
   *  Purpose: Approve or revoke `operator` for all of `owner`’s editions using a signature.
   *  @param owner    Token owner (signer of `v,r,s`).
   *  @param operator Operator to approve/revoke.
   *  @param approved `true` to grant; `false` to revoke.
   *  @param deadline Signature expiry (unix seconds).
   *  @param vrs      Signature parts `{ v, r, s }`.
   *  @returns        Transaction receipt upon inclusion.
   */
  async permitForAll(
    owner: Address,
    operator: Address,
    approved: boolean,
    deadline: bigint | number,
    vrs: { v: number; r: BytesLike; s: BytesLike }
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.permitForAll(owner, operator, approved, deadline, vrs.v, vrs.r, vrs.s);
    return tx.wait();
  }

  /** Burn all **expired** balances of the caller for a set of ids.
   *  Purpose: Self-sweep; reverts if nothing is expired.
   *  @param ids Token ids to check and burn if expired.
   *  @returns   Transaction receipt upon inclusion.
   */
  async sweepExpired(ids: readonly (bigint | number)[]): Promise<TransactionReceipt> {
    const tx = await this.contract.sweepExpired(ids);
    return tx.wait();
  }

  /** Admin sweep: burn **expired** balances of `from` for a set of ids (MINTER_ROLE).
   *  Purpose: Operational cleanup for expired editions.
   *  @param from Address whose expired balances will be burned.
   *  @param ids  Token ids to check and burn if expired.
   *  @returns    Transaction receipt upon inclusion.
   */
  async sweepExpiredFrom(from: Address, ids: readonly (bigint | number)[]): Promise<TransactionReceipt> {
    const tx = await this.contract.sweepExpiredFrom(from, ids);
    return tx.wait();
  }

  /* ================================================================ */
  /* 5) Views                                                          */
  /* ================================================================ */

  /** Contract type string (for factory/registry UIs). */
  async contractType(): Promise<string> { return this.contract.contractType() as Promise<string>; }

  /** Contract semantic version string. */
  async contractVersion(): Promise<string> { return this.contract.contractVersion() as Promise<string>; }

  /** Base URI currently stored in ERC1155. */
  async contractURI(): Promise<string> { return this.contract.contractURI() as Promise<string>; }

  /** Per-id token URI (falls back to base when empty). */
  async uri(id: bigint | number): Promise<string> { return this.contract.uri(id) as Promise<string>; }

  /** Total supply for a given id (minted − burned). */
  async totalSupply(id: bigint | number): Promise<bigint> {
    return BigInt(await this.contract.totalSupply(id));
  }

  /** Cumulative minted amount for id. */
  async totalMinted(id: bigint | number): Promise<bigint> {
    return BigInt(await this.contract.totalMinted(id));
  }

  /** Max supply cap for id (0 = unlocked/unlimited). */
  async maxSupply(id: bigint | number): Promise<bigint> {
    return BigInt(await this.contract.maxSupply(id));
  }

  /** Arbitrary reward type associated to id. */
  async rewardTypeOf(id: bigint | number): Promise<bigint> {
    return BigInt(await this.contract.rewardTypeOf(id));
  }

  /** Current whitelist registry address (0x0 if disabled). */
  async whitelist(): Promise<Address> {
    return (await this.contract.whitelist()) as Address;
  }

  /** ERC-2771 meta-tx forwarder check. */
  async isTrustedForwarder(fwd: Address): Promise<boolean> {
    return this.contract.isTrustedForwarder(fwd) as Promise<boolean>;
  }

  /** Soulbound flag (true blocks non-mint/non-burn transfers between EOAs). */
  async soulbound(): Promise<boolean> {
    return this.contract.soulbound() as Promise<boolean>;
  }

  /** ERC165 support check. */
  async supportsInterface(iid: BytesLike): Promise<boolean> {
    return this.contract.supportsInterface(iid) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 6) EIP-712 Utilities (off-chain helpers)                           */
  /* ================================================================ */

  /** Compute the exact EIP-712 digest used by `redeemVoucher` for a given domain and voucher.
   *  Purpose: Pre-validate signatures or generate them off-chain.
   *  @param chainId  EVM chain id.
   *  @param voucher  `MintVoucher` payload.
   *  @returns        32-byte digest to be signed by `voucher.issuer`.
   */
  computeVoucherDigest(chainId: number, voucher: MintVoucher): Bytes32 {
    const domain = {
      name: EIP712_NAME,
      version: EIP712_VERSION,
      chainId,
      verifyingContract: this.address,
    };
    const digest = ethers.TypedDataEncoder.hash(domain, VOUCHER_TYPES as any, voucher as any);
    return digest as Bytes32;
  }

  /** Sign a MintVoucher (wallet must match `voucher.issuer`).
   *  Purpose: Helper for tests or distribution tooling to produce signatures.
   *  @param signer   Ethers signer used to sign typed data (must be `voucher.issuer`).
   *  @param chainId  EVM chain id.
   *  @param voucher  `MintVoucher` payload to sign.
   *  @returns        Hex signature suitable for `redeemVoucher`.
   */
  async signVoucher(
    signer: ethers.Signer,
    chainId: number,
    voucher: MintVoucher
  ): Promise<string> {
    const domain = {
      name: EIP712_NAME,
      version: EIP712_VERSION,
      chainId,
      verifyingContract: this.address,
    };
    // @ts-ignore: signer.signTypedData types vary between environments
    return signer.signTypedData(domain, VOUCHER_TYPES as any, voucher as any);
  }

  /* ================================================================ */
  /* 7) Event Queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `MetadataUpdate(id)` events. */
  async queryMetadataUpdate(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.MetadataUpdate);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `RewardRedeemed(user,id,amount)` events. */
  async queryRewardRedeemed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.RewardRedeemed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query ERC1155 `TransferSingle` events. */
  async queryTransferSingle(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.TransferSingle);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query ERC1155 `TransferBatch` events. */
  async queryTransferBatch(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.TransferBatch);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query ERC1155 `ApprovalForAll` events. */
  async queryApprovalForAll(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.ApprovalForAll);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }
}

export default PrivilegeEditionHelper;
