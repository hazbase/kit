/* ------------------------------------------------------------------ */
/*  PrivilegeNFTHelper — ERC-721 Privilege/Reward NFT                  */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  TransactionReceipt,
  BytesLike,
} from "ethers";

import { PrivilegeNFT } from "../contracts/PrivilegeNFT";
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;
export type Bytes32 = string;

/** Deploy-time arguments (forwarded to initialize). */
export interface DeployArgs {
  /** Base URI (e.g., "ipfs://.../") used by tokenURI when no per-id URI set. */
  baseURI: string;
  /** DEFAULT_ADMIN_ROLE holder (timelock recommended). */
  admin: Address;
  /** ERC-2771 trusted forwarders (can be empty). */
  trustedForwarders?: readonly Address[];
  /** Default royalty receiver (ERC-2981). */
  royaltyReceiver: Address;
  /** Default royalty fee in basis points (0..10000). */
  royaltyFeeBps: number;
}

/** Result of deployment via factory (uses `res.address`). */
export interface DeployResult {
  /** Proxy address of the deployed instance. */
  address: Address;
  /** Deployment/initialize transaction receipt. */
  receipt: TransactionReceipt;
  /** Connected helper bound to the new proxy. */
  helper: PrivilegeNFTHelper;
}

/** Voucher struct for lazy minting (must match Solidity field order & types). */
export interface MintVoucher {
  /** Token id to mint. */
  id: bigint | number;
  /** Per-id metadata URI (empty string to fallback to baseURI). */
  uri: string;
  /** Voting tier factor (0..255) used by Votes module. */
  tier: number;
  /** Unix seconds when this NFT expires (used for sweep/redeem checks). */
  expiresAt: bigint | number;
  /** Unix seconds (inclusive) until which the voucher is valid. */
  validUntil: bigint | number;
  /** Issuer-chosen unique nonce (anti-replay). */
  nonce: bigint | number;
  /** Signer address (must hold MINTER_ROLE). */
  issuer: Address;
  /** Recipient; if zero, contract uses _msgSender(). */
  to: Address;
}

export interface OptionalArgs {
  abi?: InterfaceAbi
}

/* ------------------------------------------------------------------ */
/*                         EIP-712 Definitions                         */
/* ------------------------------------------------------------------ */

export const EIP712_NAME = "PrivilegeNFT";
export const EIP712_VERSION = "1";

/** Typed struct used by on-chain `redeemVoucher`. */
const VOUCHER_TYPES = {
  MintVoucher: [
    { name: "id",         type: "uint256" },
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
  RewardRedeemed : "RewardRedeemed(address,uint256)",
  Transfer       : "Transfer(address,address,uint256)",
  Approval       : "Approval(address,address,uint256)",
  ApprovalForAll : "ApprovalForAll(address,address,bool)",
} as const;

/* ------------------------------------------------------------------ */
/*                              Helper                                 */
/* ------------------------------------------------------------------ */

export class PrivilegeNFTHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;
  readonly ops     : OptionalArgs | undefined;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner, ops?: OptionalArgs) {
    this.address  = ethers.getAddress(address) as Address;
    this.runner   = runner;

    this.ops = ops;
    this.contract = new ethers.Contract(this.address, ops?.abi? [...PrivilegeNFT.abi, ...ops.abi]: PrivilegeNFT.abi, runner);
  }

  /* ================================================================ */
  /* 1) Deploy / Attach / Connect                                      */
  /* ================================================================ */

  /** Deploy a new PrivilegeNFT proxy and return a connected helper.
   *  Purpose: Initialize an ERC-721 collection with royalties, voting tiers, EIP-712, and meta-tx.
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
      contractType : PrivilegeNFT.contractType, // e.g., "PrivilegeNFT"
      implABI      : PrivilegeNFT.abi,
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

    const helper = new PrivilegeNFTHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing PrivilegeNFT at `address`.
   *  Purpose: Bind helper to a deployed proxy for calls/transactions.
   *  @param address Target contract address.
   *  @param runner  Signer or provider context.
   *  @returns       Connected helper instance.
   */
  static attach(address: Address, runner: ContractRunner, ops?: OptionalArgs): PrivilegeNFTHelper {
    return new PrivilegeNFTHelper(address, runner, ops);
  }

  /** Return a new helper bound to a different signer/runner.
   *  Purpose: Swap wallet/provider without re-attaching.
   *  @param runner New signer or provider.
   *  @returns      New helper targeting the same address.
   */
  connect(runner: ContractRunner): PrivilegeNFTHelper {
    if (runner === this.runner) return this;
    return new PrivilegeNFTHelper(this.address, runner, this.ops);
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
   *  Purpose: Remove royalty info; per-token settings, if any, remain.
   *  @returns Transaction receipt upon inclusion.
   */
  async deleteDefaultRoyalty(): Promise<TransactionReceipt> {
    const tx = await this.contract.deleteDefaultRoyalty();
    return tx.wait();
  }

  /** Set voting tier for a token id **before** mint.
   *  Purpose: Adjust per-id voting weight factor (0..255).
   *  @param id      Token id to assign a tier to.
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
   *  Purpose: Create a token id and set its metadata & reward type.
   *  @param to     Recipient address.
   *  @param id     Token id to mint.
   *  @param uri    Per-id metadata URI (empty string to use baseURI).
   *  @param tier   Voting tier factor (0..255).
   *  @param exp    Expiry timestamp (unix seconds).
   *  @param rType  Arbitrary reward type flag to associate with `id`.
   *  @returns      Transaction receipt upon inclusion.
   */
  async mint(
    to: Address,
    id: bigint | number,
    uri: string,
    tier: number,
    exp: bigint | number,
    rType: bigint | number
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.mint(to, id, uri, tier, exp, rType);
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
  /* 4) User actions (redeem / approvals / sweeping / transfers)       */
  /* ================================================================ */

  /** Redeem (burn) a token for rewards.
   *  Purpose: Holder burns token `id`; downstream system credits the off-chain reward.
   *  @param from Holder (must be caller or approved operator).
   *  @param id   Token id to redeem (burn).
   *  @returns    Transaction receipt upon inclusion.
   */
  async redeem(from: Address, id: bigint | number): Promise<TransactionReceipt> {
    const tx = await this.contract.redeem(from, id);
    return tx.wait();
  }

  /** Permit-for-all (EIP-712) — gasless operator approval.
   *  Purpose: Approve or revoke `operator` for all of `owner`’s NFTs using a signature.
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

  /** Sweep: burn **expired** token owned by the caller.
   *  Purpose: Self-cleanup for expired NFTs. Reverts if not expired.
   *  @param id Token id to check and burn if expired.
   *  @returns  Transaction receipt upon inclusion.
   */
  async sweepExpired(id: bigint | number): Promise<TransactionReceipt> {
    const tx = await this.contract.sweepExpired(id);
    return tx.wait();
  }

  /** Admin sweep: burn **expired** token owned by `from` (MINTER_ROLE).
   *  Purpose: Operational cleanup for expired NFTs.
   *  @param from Address whose expired token will be burned.
   *  @param id   Token id to check and burn if expired.
   *  @returns    Transaction receipt upon inclusion.
   */
  async sweepExpiredFrom(from: Address, id: bigint | number): Promise<TransactionReceipt> {
    const tx = await this.contract.sweepExpiredFrom(from, id);
    return tx.wait();
  }

  /** setApprovalForAll — standard ERC-721 operator approval.
   *  Purpose: Approve or revoke `operator` for all tokens.
   *  @param operator Operator address.
   *  @param approved `true` to approve; `false` to revoke.
   *  @returns        Transaction receipt upon inclusion.
   */
  async setApprovalForAll(operator: Address, approved: boolean): Promise<TransactionReceipt> {
    const tx = await this.contract.setApprovalForAll(operator, approved);
    return tx.wait();
  }

  /** approve — approve an operator for a single token.
   *  Purpose: Allow `to` to transfer `tokenId`.
   *  @param to       Approved operator.
   *  @param tokenId  Token id to approve.
   *  @returns        Transaction receipt upon inclusion.
   */
  async approve(to: Address, tokenId: bigint | number): Promise<TransactionReceipt> {
    const tx = await this.contract.approve(to, tokenId);
    return tx.wait();
  }

  /** safeTransferFrom — standard ERC-721 transfer (with receiver check).
   *  Purpose: Move `tokenId` from `from` to `to`.
   *  @param from     Current owner.
   *  @param to       Recipient.
   *  @param tokenId  Token id to transfer.
   *  @param data     Optional bytes data forwarded to receiver hook.
   *  @returns        Transaction receipt upon inclusion.
   */
  async safeTransferFrom(
    from: Address,
    to: Address,
    tokenId: bigint | number,
    data: BytesLike = "0x"
  ): Promise<TransactionReceipt> {
    const tx = await this.contract["safeTransferFrom(address,address,uint256,bytes)"](from, to, tokenId, data);
    return tx.wait();
  }

  /* ================================================================ */
  /* 5) Views                                                          */
  /* ================================================================ */

  /** Contract type string (for factory/registry UIs). */
  async contractType(): Promise<string> { return this.contract.contractType() as Promise<string>; }

  /** Contract semantic version string. */
  async contractVersion(): Promise<string> { return this.contract.contractVersion() as Promise<string>; }

  /** Base URI currently stored in the contract (collection URI). */
  async contractURI(): Promise<string> { return this.contract.contractURI() as Promise<string>; }

  /** tokenURI for a specific token id. */
  async tokenURI(id: bigint | number): Promise<string> { return this.contract.tokenURI(id) as Promise<string>; }

  /** Current total supply (number of existing tokens). */
  async totalSupply(): Promise<bigint> { return BigInt(await this.contract.totalSupply()); }

  /** Cumulative minted tokens so far (may include burned). */
  async totalMinted(): Promise<bigint> { return BigInt(await this.contract.totalMinted()); }

  /** Max supply cap for the whole collection (0 = unlimited). */
  async maxSupply(): Promise<bigint> { return BigInt(await this.contract.maxSupply()); }

  /** Arbitrary reward type associated to a token id. */
  async rewardTypeOf(id: bigint | number): Promise<bigint> {
    return BigInt(await this.contract.rewardTypeOf(id));
  }

  /** Voting tier for a token id (0..255). */
  async tierOf(id: bigint | number): Promise<number> {
    return Number(await this.contract.tierOf(id));
  }

  /** Expiry timestamp for a token id (unix seconds). */
  async expiresAtOf(id: bigint | number): Promise<bigint> {
    return BigInt(await this.contract.expiresAtOf(id));
  }

  /** Current whitelist registry address (0x0 if disabled). */
  async whitelist(): Promise<Address> { return (await this.contract.whitelist()) as Address; }

  /** Owner of token id. */
  async ownerOf(id: bigint | number): Promise<Address> { return (await this.contract.ownerOf(id)) as Address; }

  /** ERC-2771 meta-tx forwarder check. */
  async isTrustedForwarder(fwd: Address): Promise<boolean> {
    return this.contract.isTrustedForwarder(fwd) as Promise<boolean>;
  }

  /** Soulbound flag (true blocks non-mint/non-burn transfers between EOAs). */
  async soulbound(): Promise<boolean> { return this.contract.soulbound() as Promise<boolean>; }

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

  /** Query `RewardRedeemed(user,id)` events. */
  async queryRewardRedeemed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.RewardRedeemed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query ERC-721 `Transfer` events. */
  async queryTransfer(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Transfer);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query ERC-721 `Approval` events. */
  async queryApproval(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Approval);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query ERC-721 `ApprovalForAll` events. */
  async queryApprovalForAll(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.ApprovalForAll);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }
}

export default PrivilegeNFTHelper;
