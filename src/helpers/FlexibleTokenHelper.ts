/* ------------------------------------------------------------------ */
/*  FlexibleTokenHelper — Developer-friendly wrapper for FlexibleToken */
/* ------------------------------------------------------------------ */
/*  Overview
    - Mirrors FlexibleToken.sol (ERC20Votes, Pausable, UUPS, ERC2771, Roles).
    - Provides typed helpers for:
        * deploy (proxy via factory), attach, connect
        * mint / batchMint / burn / batchBurn
        * redeemVoucher (EIP-712 off-chain authorized mint)
        * setCap, setWhitelist, pause / unpause
        * ERC20Votes & ERC20Permit conveniences (delegate, getVotes, permit)
        * views: cap, transferable, whitelist, redeemed, name/symbol/decimals, totals
        * event queries: CapChanged, WhitelistConfigured, VoucherRedeemed
    - All function headers describe purpose, parameters, and return values.       */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  TransactionReceipt,
  BytesLike,
  BigNumberish,
} from "ethers";

import { FlexibleToken as FT } from "../contracts/FlexibleToken";
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;
export type Bytes32 = string;

/** Deploy-time arguments mapped to FlexibleToken.initialize(...) */
export interface DeployArgs {
  /** ERC-20 name */
  name: string;
  /** ERC-20 symbol */
  symbol: string;
  /** Recipient of initial supply (also granted MINTER_ROLE) */
  treasury: Address;
  /** Initial mint amount sent to `treasury` (cap-checked) */
  initialSupply: BigNumberish;
  /** Supply cap (0 ⇒ unlimited) */
  cap: BigNumberish;
  /** ERC-20 decimals (0..18) */
  decimals: number;
  /** true ⇒ transferable, false ⇒ soul-bound (non-transferable) */
  transferable: boolean;
  /** DEFAULT_ADMIN_ROLE holder (timelock recommended) */
  admin: Address;
  /** ERC-2771 trusted forwarders */
  forwarders?: readonly Address[];
}

/** Result of deployment via factory (uses `res.address`) */
export interface DeployResult {
  address: Address;                 // Proxy address
  receipt: TransactionReceipt;      // Deployment/initialize receipt
  helper : FlexibleTokenHelper;     // Connected helper
}

/** Struct used by `redeemVoucher` (EIP-712) */
export interface MintVoucher {
  /** Address that signed and must hold MINTER_ROLE */
  issuer: Address;
  /** Recipient; if zero, contract uses _msgSender() */
  to: Address;
  /** Mint amount */
  amount: BigNumberish;
  /** Redemption deadline (unix seconds; inclusive) */
  validUntil: BigNumberish;
  /** Arbitrary nonce to avoid collisions */
  nonce: BigNumberish;
}

/* ------------------------------------------------------------------ */
/*                            EIP-712 Types                            */
/* ------------------------------------------------------------------ */

const VOUCHER_TYPES = {
  MintVoucher: [
    { name: "issuer",     type: "address"  },
    { name: "to",         type: "address"  },
    { name: "amount",     type: "uint256"  },
    { name: "validUntil", type: "uint64"   },
    { name: "nonce",      type: "uint256"  },
  ],
} as const;

/* ------------------------------------------------------------------ */
/*                              Events                                 */
/* ------------------------------------------------------------------ */

const EVT = {
  CapChanged          : "CapChanged(uint256,uint256)",
  WhitelistConfigured : "WhitelistConfigured(address)",
  VoucherRedeemed     : "VoucherRedeemed(bytes32,address,uint256)",
} as const;

/* ------------------------------------------------------------------ */
/*                              Helper                                 */
/* ------------------------------------------------------------------ */

export class FlexibleTokenHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner) {
    this.address  = ethers.getAddress(address) as Address;
    this.runner   = runner;
    this.contract = new ethers.Contract(this.address, FT.abi as InterfaceAbi, runner);
  }

  /* ================================================================ */
  /* 1) Deploy / Attach / Connect                                      */
  /* ================================================================ */

  /** Deploy a new FlexibleToken proxy and return a connected helper.
   *  Purpose: Initialize a configurable ERC20Votes token with optional cap and soul-bound behavior.
   *  @param args   See DeployArgs — forwarded to `initialize(...)` on-chain.
   *  @param signer Ethers signer used for deployment and initializer call.
   *  @param opts   Optional factory options (salt, factory address, etc.).
   *  @returns      { address, receipt, helper } for immediate use.
   */
  static async deploy(
    args: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions, "contractType" | "implABI" | "initArgs" | "signer">>,
  ): Promise<DeployResult> {
    const res = await deployViaFactory({
      contractType : FT.contractType, // e.g., "FlexibleToken"
      implABI      : FT.abi,
      initArgs     : [
        args.name,
        args.symbol,
        args.treasury,
        args.initialSupply,
        args.cap,
        args.decimals,
        args.transferable,
        args.admin,
        args.forwarders ?? []
      ],
      signer,
      ...(opts ?? {}),
    });

    const helper = new FlexibleTokenHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing FlexibleToken at `address`.
   *  Purpose: Create a helper bound to a deployed proxy or implementation.
   *  @param address Target contract address.
   *  @param runner  Signer or provider to perform calls/txs.
   *  @returns       Connected helper instance.
   */
  static attach(address: Address, runner: ContractRunner | ethers.Signer): FlexibleTokenHelper {
    return new FlexibleTokenHelper(address, runner);
  }

  /** Return a new helper bound to a different signer/runner.
   *  Purpose: Swap execution context (e.g., change wallet) without re-attaching.
   *  @param runner New signer or provider.
   *  @returns      New helper instance sharing the same address.
   */
  connect(runner: ContractRunner | ethers.Signer): FlexibleTokenHelper {
    if (runner === this.runner) return this;
    return new FlexibleTokenHelper(this.address, runner);
  }

  /* ================================================================ */
  /* 2) Mint / Burn                                                    */
  /* ================================================================ */

  /** Mint tokens to `to` (MINTER_ROLE required, whenNotPaused).
   *  Purpose: Increase supply within cap (if non-zero).
   *  @param to     Recipient address.
   *  @param amount Mint amount (wei units of token).
   *  @returns      Transaction receipt upon inclusion.
   */
  async mint(to: Address, amount: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.mint(to, amount);
    return tx.wait();
  }

  /** Batch mint to multiple recipients (MINTER_ROLE, whenNotPaused).
   *  Purpose: Gas-efficient distribution; checks aggregated cap if set.
   *  @param to       Array of recipient addresses.
   *  @param amounts  Array of mint amounts per recipient (same length as `to`).
   *  @returns        Transaction receipt upon inclusion.
   */
  async batchMint(to: readonly Address[], amounts: readonly BigNumberish[]): Promise<TransactionReceipt> {
    const tx = await this.contract.batchMint(to, amounts);
    return tx.wait();
  }

  /** Burn tokens from `from` (MINTER_ROLE required, whenNotPaused).
   *  Purpose: Decrease supply from a specific holder.
   *  @param from   Address whose balance is reduced.
   *  @param amount Burn amount.
   *  @returns      Transaction receipt upon inclusion.
   */
  async burn(from: Address, amount: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.burn(from, amount);
    return tx.wait();
  }

  /** Batch burn from multiple holders (MINTER_ROLE, whenNotPaused).
   *  Purpose: Gas-efficient reduction across many addresses.
   *  @param from     Array of holder addresses.
   *  @param amounts  Array of burn amounts (same length as `from`).
   *  @returns        Transaction receipt upon inclusion.
   */
  async batchBurn(from: readonly Address[], amounts: readonly BigNumberish[]): Promise<TransactionReceipt> {
    const tx = await this.contract.batchBurn(from, amounts);
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Voucher (EIP-712)                                              */
  /* ================================================================ */

  /** Redeem an off-chain signed MintVoucher (nonReentrant, whenNotPaused).
   *  Purpose: Authorized airdrop/mint flow without granting MINTER_ROLE to relayer.
   *  @param voucher The MintVoucher payload (issuer, to, amount, validUntil, nonce).
   *  @param sig     EIP-712 signature from `voucher.issuer` (who must hold MINTER_ROLE).
   *  @returns       `{ amount, receipt, digest }` where `amount` is minted amount returned by the contract,
   *                 and `digest` is the EIP-712 hash for record-keeping.
   *
   *  Notes:
   *  - Contract computes `digest = _hashTypedDataV4(keccak256(abi.encode(...)))` and verifies the signer.
   *  - If `voucher.to == 0x0`, recipient becomes `_msgSender()` (ERC-2771-aware).
   *  - Emits `VoucherRedeemed(digest, to, amount)`.
   */
  async redeemVoucher(
    voucher: MintVoucher,
    sig: BytesLike
  ): Promise<{ amount: bigint; digest: Bytes32; receipt: TransactionReceipt }> {
    const tx = await this.contract.redeemVoucher(voucher, sig);
    const rc = await tx.wait();

    // Extract digest & amount from emitted event (robust vs ABI return handling in txs)
    let minted = 0n;
    let digest: Bytes32 = "0x".padEnd(66, "0") as Bytes32;
    for (const log of rc.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed?.name === "VoucherRedeemed") {
          digest = parsed.args?.digest as Bytes32;
          minted = BigInt(parsed.args?.amount ?? parsed.args?.[2]);
          break;
        }
      } catch {/* ignore non-matching logs */}
    }
    return { amount: minted, digest, receipt: rc };
  }

  /** Compute the EIP-712 digest for a MintVoucher exactly as the contract does.
   *  Purpose: Pre-validate signatures or generate them off-chain.
   *  @param chainId  Chain id for the EIP-712 domain.
   *  @param name     Token name used by EIP-712 domain (usually `await name()`).
   *  @param voucher  The voucher payload to hash.
   *  @returns        32-byte digest to be signed / compared on-chain.
   */
  computeVoucherDigest(chainId: number, name: string, voucher: MintVoucher): Bytes32 {
    const domain = {
      name,
      version: "1",                          // OZ ERC20Permit/EIP712 default
      chainId,
      verifyingContract: this.address,
    };
    // ethers v6 TypedDataEncoder
    const hash = ethers.TypedDataEncoder.hash(domain, VOUCHER_TYPES as any, voucher as any);
    return hash as Bytes32;
  }

  /** Sign a MintVoucher with a signer (wallet must match `voucher.issuer`).
   *  Purpose: Helper for tests/off-chain distribution tools.
   *  @param signer   Ethers signer used to sign typed data.
   *  @param chainId  Chain id for the EIP-712 domain.
   *  @param name     Token name for domain (usually `await name()`).
   *  @param voucher  Voucher payload.
   *  @returns        Signature bytes ready for `redeemVoucher`.
   */
  async signVoucher(
    signer: ethers.Signer,
    chainId: number,
    name: string,
    voucher: MintVoucher
  ): Promise<string> {
    const domain = {
      name,
      version: "1",
      chainId,
      verifyingContract: this.address,
    };
    // ethers v6 signer.signTypedData
    // @ts-ignore - types for signTypedData may differ across environments
    return signer.signTypedData(domain, VOUCHER_TYPES as any, voucher as any);
  }

  /* ================================================================ */
  /* 4) Admin: Cap / Whitelist / Pause                                */
  /* ================================================================ */

  /** Update the cap; 0 means unlimited (ADMIN_ROLE).
   *  Purpose: Change maximum total supply limit.
   *  @param newCap New cap value (0 ⇒ unlimited).
   *  @returns      Transaction receipt upon inclusion.
   */
  async setCap(newCap: BigNumberish): Promise<TransactionReceipt> {
    const tx = await this.contract.setCap(newCap);
    return tx.wait();
  }

  /** Configure/replace the whitelist registry (GUARDIAN_ROLE).
   *  Purpose: Enforce allow-listing on sender & recipient for transfers when set.
   *  @param registry Whitelist contract address (0x0 to disable).
   *  @returns        Transaction receipt upon inclusion.
   */
  async setWhitelist(registry: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.setWhitelist(registry);
    return tx.wait();
  }

  /** Pause state-changing entrypoints (PAUSER_ROLE).
   *  Purpose: Emergency stop for mint/burn/transfer.
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
  /* 5) ERC20Votes & Permit conveniences                               */
  /* ================================================================ */

  /** Delegate voting power to `delegatee`. 
   *  Purpose: Assign the caller’s voting power to another address.
   *  @param delegatee Address to receive voting power.
   *  @returns         Transaction receipt upon inclusion.
   */
  async delegate(delegatee: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.delegate(delegatee);
    return tx.wait();
  }

  /** Delegate by signature (gasless).
   *  Purpose: Off-chain signed delegation usable by a relayer.
   *  @returns Transaction receipt upon inclusion.
   */
  async delegateBySig(
    delegatee: Address,
    nonce: BigNumberish,
    expiry: BigNumberish,
    v: number,
    r: BytesLike,
    s: BytesLike
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.delegateBySig(delegatee, nonce, expiry, v, r, s);
    return tx.wait();
  }

  /** Current delegate for `account`. */
  async delegates(account: Address): Promise<Address> {
    return (await this.contract.delegates(account)) as Address;
  }

  /** Current votes for `account` (latest checkpoint). */
  async getVotes(account: Address): Promise<bigint> {
    return BigInt(await this.contract.getVotes(account));
  }

  /** Past votes for `account` at `blockNumber`. */
  async getPastVotes(account: Address, blockNumber: BigNumberish): Promise<bigint> {
    return BigInt(await this.contract.getPastVotes(account, blockNumber));
  }

  /** Past total supply at `blockNumber` (for quorum calculations). */
  async getPastTotalSupply(blockNumber: BigNumberish): Promise<bigint> {
    return BigInt(await this.contract.getPastTotalSupply(blockNumber));
  }

  /** ERC20 Permit (EIP-2612) approval with signature.
   *  Purpose: Approve `spender` for `value` without on-chain tx by owner.
   *  @returns Transaction receipt upon inclusion.
   */
  async permit(
    owner: Address,
    spender: Address,
    value: BigNumberish,
    deadline: BigNumberish,
    v: number,
    r: BytesLike,
    s: BytesLike
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.permit(owner, spender, value, deadline, v, r, s);
    return tx.wait();
  }

  /** Current nonce for `owner` (required for permit). */
  async nonces(owner: Address): Promise<bigint> {
    return BigInt(await this.contract.nonces(owner));
  }

  /* ================================================================ */
  /* 6) Views                                                          */
  /* ================================================================ */

  /** Max total supply; 0 means unlimited. */
  async cap(): Promise<bigint> {
    return BigInt(await this.contract.cap());
  }

  /** Soul-bound mode flag; false disables normal transfers. */
  async transferable(): Promise<boolean> {
    return this.contract.transferable() as Promise<boolean>;
  }

  /** Whitelist registry address (0x0 if disabled). */
  async whitelist(): Promise<Address> {
    return (await this.contract.whitelist()) as Address;
  }

  /** Redeemed status for a voucher digest (replay protection). */
  async redeemed(digest: Bytes32): Promise<boolean> {
    return this.contract.redeemed(digest) as Promise<boolean>;
  }

  /** ERC-2771: true if `forwarder` is a trusted meta-tx forwarder. */
  async isTrustedForwarder(forwarder: Address): Promise<boolean> {
    return this.contract.isTrustedForwarder(forwarder) as Promise<boolean>;
  }

  /** ERC-20 name. */
  async name(): Promise<string> { return this.contract.name() as Promise<string>; }
  /** ERC-20 symbol. */
  async symbol(): Promise<string> { return this.contract.symbol() as Promise<string>; }
  /** ERC-20 decimals. */
  async decimals(): Promise<number> { return Number(await this.contract.decimals()); }
  /** Total token supply. */
  async totalSupply(): Promise<bigint> { return BigInt(await this.contract.totalSupply()); }
  /** Balance of `account`. */
  async balanceOf(account: Address): Promise<bigint> { return BigInt(await this.contract.balanceOf(account)); }
  /** Allowance from `owner` to `spender`. */
  async allowance(owner: Address, spender: Address): Promise<bigint> {
    return BigInt(await this.contract.allowance(owner, spender));
  }

  /* ================================================================ */
  /* 7) Event Queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `CapChanged(oldCap,newCap)` events within a block range. */
  async queryCapChanged(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.CapChanged);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `WhitelistConfigured(whitelist)` events. */
  async queryWhitelistConfigured(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.WhitelistConfigured);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `VoucherRedeemed(digest,to,amount)` events. */
  async queryVoucherRedeemed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.VoucherRedeemed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }
}

export default FlexibleTokenHelper;
