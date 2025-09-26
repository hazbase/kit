/* ------------------------------------------------------------------ */
/*  WhitelistHelper — Facade for WhitelistUpgradeable                  */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  TransactionReceipt,
  BytesLike,
} from "ethers";

import { Whitelist as WL } from "../contracts/Whitelist";
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;
export type Bytes32 = string;

/** Deploy-time arguments mapped to WhitelistUpgradeable.initialize(...) */
export interface DeployArgs {
  /** DEFAULT_ADMIN_ROLE holder */
  admin: Address;
  /** Initial Merkle root for ZK verification (bytes32 hex string) */
  initialRoot: Bytes32;
  /** Groth16-style verifier contract address (implements verifyProof) */
  verifier: Address;
  /** ERC-2771 trusted forwarders */
  trustedForwarders?: readonly Address[];
}

/** Result of deployment via factory (uses res.address, not res.proxy) */
export interface DeployResult {
  /** Proxy address */
  address: Address;
  /** Deployment/initialize transaction receipt */
  receipt: TransactionReceipt;
  /** Connected helper */
  helper: WhitelistHelper;
}

/** KYC trust level mirror (must match .sol enum order) */
export enum KYCLevel {
  None = 0,
  Basic = 1,
  ZK = 2,
}

/** zkSNARK proof tuple shapes (Groth16) */
export type ProofA = readonly [string, string];
export type ProofB = readonly [[string, string], [string, string]];
export type ProofC = readonly [string, string];
/** Public signals: [mode, root, nullifier, addr160, reserved5, reserved6] */
export type PubSignals = readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint
];

/* ------------------------------------------------------------------ */
/*                               Events                                */
/* ------------------------------------------------------------------ */

const EVT = {
  WhitelistUpdated: "WhitelistUpdated(address,uint8)",
  BatchWhitelistUpdated: "BatchWhitelistUpdated(uint256,uint8)",
  RootUpdated: "RootUpdated(bytes32,bytes32)",
  VerifierSet: "VerifierSet(address,address)",
  ZKAdded: "ZKAdded(address)",
} as const;

/* ------------------------------------------------------------------ */
/*                               Helper                                */
/* ------------------------------------------------------------------ */

export class WhitelistHelper {
  readonly address: Address;
  readonly contract: ethers.Contract;
  readonly runner: ContractRunner;

  public static KYCLevel = KYCLevel;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner) {
    this.address = ethers.getAddress(address) as Address;
    this.runner = runner;
    this.contract = new ethers.Contract(
      this.address,
      WL.abi as InterfaceAbi,
      runner
    );
  }

  /* ================================================================ */
  /* 1) Deploy / Attach / Connect                                      */
  /* ================================================================ */

  /** Deploy a new WhitelistUpgradeable proxy and return a connected helper.
   *  Purpose: Initialize a KYC/allowlist registry with admin- and ZK-managed entries.
   *  @param args   See DeployArgs — forwarded to initialize(admin, root, verifier, forwarders).
   *  @param signer Ethers signer used for deployment.
   *  @param opts   Optional factory opts (salt, factory address, gas settings).
   *  @returns      { address, receipt, helper } for immediate use.
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
      contractType: WL.contractType, // e.g., "WhitelistUpgradeable"
      implABI: WL.abi,
      initArgs: [
        args.admin,
        args.initialRoot,
        args.verifier,
        args.trustedForwarders ?? [],
      ],
      signer,
      ...(opts ?? {}),
    });

    const helper = new WhitelistHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing WhitelistUpgradeable at `address`.
   *  Purpose: Create a helper bound to a deployed proxy.
   *  @param address Target contract address.
   *  @param runner  Signer or provider to perform calls/txs.
   *  @returns       Connected helper instance.
   */
  static attach(
    address: Address,
    runner: ContractRunner | ethers.Signer
  ): WhitelistHelper {
    return new WhitelistHelper(address, runner);
  }

  /** Return a new helper bound to a different signer/runner.
   *  Purpose: Swap execution context (e.g., change wallet) without re-attaching.
   *  @param runner New signer or provider.
   *  @returns      New helper instance sharing the same address.
   */
  connect(runner: ContractRunner | ethers.Signer): WhitelistHelper {
    if (runner === this.runner) return this;
    return new WhitelistHelper(this.address, runner);
  }

  /* ================================================================ */
  /* 2) Admin: direct allowlisting (Basic level)                       */
  /* ================================================================ */

  /** Add one address as `Basic` (onlyRole(ADMIN_ROLE)).
   *  @param user  Address to set as Basic.
   *  @returns     Transaction receipt upon inclusion.
   *
   *  Solidity: function add(address user) external;
   */
  async addBasic(user: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.add(user);
    return tx.wait();
  }

  /** Remove one address (set to `None`) (onlyRole(ADMIN_ROLE)).
   *  @param user  Address to remove from the list.
   *  @returns     Transaction receipt upon inclusion.
   *
   *  Solidity: function remove(address user) external;
   */
  async removeBasic(user: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.remove(user);
    return tx.wait();
  }

  /** Batch add addresses as `Basic` (onlyRole(ADMIN_ROLE)).
   *  @param users Array of addresses to set as Basic.
   *  @returns     Transaction receipt upon inclusion.
   *
   *  Solidity: function addBatch(address[] calldata u) external;
   */
  async addBasicBatch(users: readonly Address[]): Promise<TransactionReceipt> {
    const tx = await this.contract.addBatch(users);
    return tx.wait();
  }

  /** Batch remove addresses (set to `None`) (onlyRole(ADMIN_ROLE)).
   *  @param users Array of addresses to remove.
   *  @returns     Transaction receipt upon inclusion.
   *
   *  Solidity: function removeBatch(address[] calldata u) external;
   */
  async removeBasicBatch(
    users: readonly Address[]
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.removeBatch(users);
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) ZK add & Verifier / Root management                            */
  /* ================================================================ */

  /** Add an address as `ZK` by verifying a Groth16 proof (onlyRole(VERIFIER_ROLE)).
   *  Purpose: Trust-minimized allowlisting against the current Merkle root.
   *  @param to          Address to mark as ZK upon successful verification.
   *  @param a           Groth16 proof `a` (uint256[2]).
   *  @param b           Groth16 proof `b` (uint256[2][2]).
   *  @param c           Groth16 proof `c` (uint256[2]).
   *  @param pubSignals  Public signals (uint256[6]):
   *                      [0]=mode(0=KYC), [1]=root, [2]=nullifier, [3]=uint160(to), [4],[5]=reserved.
   *  @returns           `{ nullifier, receipt }`. Emits `ZKAdded(to)` on success.
   *
   *  Solidity:
   *    function addWithVerify(
   *      address to,
   *      uint[2] calldata a,
   *      uint[2][2] calldata b,
   *      uint[2] calldata c,
   *      uint[6] calldata pubSignals
   *    ) external whenNotPaused onlyRole(VERIFIER_ROLE);
   */
  async addZK(
    to: Address,
    a: ProofA,
    b: ProofB,
    c: ProofC,
    pubSignals: PubSignals
  ): Promise<{ nullifier: Bytes32; receipt: TransactionReceipt }> {
    const tx = await this.contract.addWithVerify(to, a, b, c, pubSignals);
    const receipt = await tx.wait();
    // Nullifier is pubSignals[2] encoded as bytes32
    const n = BigInt(pubSignals[2]);
    const nullifier = (ethers.hexlify(
      ethers.zeroPadValue(ethers.toBeHex(n), 32)
    ) as Bytes32);
    return { nullifier, receipt };
  }

  /** Update the active Merkle root (onlyRole(VERIFIER_ROLE)).
   *  Purpose: Rotate the cohort root used for zk verification.
   *  @param newRoot New bytes32 root.
   *  @returns       Transaction receipt upon inclusion.
   *
   *  Solidity: function setRoot(bytes32 newRoot) external;
   */
  async setRoot(newRoot: Bytes32): Promise<TransactionReceipt> {
    const tx = await this.contract.setRoot(newRoot);
    return tx.wait();
  }

  /** Replace the Groth16 verifier contract (onlyRole(ADMIN_ROLE)).
   *  Purpose: Swap verifier implementation if needed.
   *  @param v New verifier contract address.
   *  @returns Transaction receipt upon inclusion.
   *
   *  Solidity: function setVerifier(address v) external;
   */
  async setVerifier(v: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.setVerifier(v);
    return tx.wait();
  }

  /* ================================================================ */
  /* 4) Pausable                                                      */
  /* ================================================================ */

  /** Pause state-changing entrypoints (onlyRole(PAUSER_ROLE)).
   *  Purpose: Emergency stop for add/remove/root updates.
   *  @returns Transaction receipt upon inclusion.
   *
   *  Solidity: function pause() external;
   */
  async pause(): Promise<TransactionReceipt> {
    const tx = await this.contract.pause();
    return tx.wait();
  }

  /** Unpause state-changing entrypoints (onlyRole(PAUSER_ROLE)).
   *  Purpose: Resume operations after pause.
   *  @returns Transaction receipt upon inclusion.
   *
   *  Solidity: function unpause() external;
   */
  async unpause(): Promise<TransactionReceipt> {
    const tx = await this.contract.unpause();
    return tx.wait();
  }

  /* ================================================================ */
  /* 5) Views                                                          */
  /* ================================================================ */

  /** True if a user is whitelisted at any level (`Basic` or `ZK`).
   *  @param user Address to check.
   *  @returns    Boolean result.
   *
   *  Solidity: function isWhitelisted(address user) external view returns (bool);
   */
  async isWhitelisted(user: Address): Promise<boolean> {
    return this.contract.isWhitelisted(user) as Promise<boolean>;
  }

  /** Get the KYC level for a user.
   *  @param user Address to query.
   *  @returns    KYCLevel enum value (0=None, 1=Basic, 2=ZK).
   *
   *  Solidity: function kycLevel(address user) external view returns (KYCLevel);
   */
  async kycLevel(user: Address): Promise<KYCLevel> {
    return this.contract.kycLevel(user) as Promise<KYCLevel>;
  }

  /** Check if a nullifier hash has already been consumed.
   *  @param nullifier Bytes32 nullifier hash.
   *  @returns         True if used (replay protected), false otherwise.
   *
   *  Solidity: function usedNullifier(bytes32 nf) external view returns (bool);
   */
  async usedNullifier(nullifier: Bytes32): Promise<boolean> {
    return this.contract.usedNullifier(nullifier) as Promise<boolean>;
  }

  /** Current Merkle root used for zk verification.
   *  @returns Bytes32 hex string (0x…).
   *
   *  Solidity: bytes32 public currentRoot;
   */
  async currentRoot(): Promise<Bytes32> {
    return (await this.contract.currentRoot()) as Bytes32;
  }

  /** Current verifier contract address.
   *  @returns Address of the verifier.
   *
   *  Solidity: IVerifier public verifier;
   */
  async verifier(): Promise<Address> {
    return (await this.contract.verifier()) as Address;
  }

  /** ERC-2771: true if `forwarder` is a trusted meta-tx forwarder.
   *  @param fwd Forwarder address to check.
   *  @returns   Boolean result.
   */
  async isTrustedForwarder(fwd: Address): Promise<boolean> {
    return this.contract.isTrustedForwarder(fwd) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 6) Role helpers (optional conveniences)                           */
  /* ================================================================ */

  /** Read VERIFIER_ROLE selector. */
  async VERIFIER_ROLE(): Promise<Bytes32> {
    return this.contract.VERIFIER_ROLE() as Promise<Bytes32>;
  }

  /** Grant a role (bytes32) to an account (DEFAULT_ADMIN_ROLE required).
   *  @param role    Role id (bytes32).
   *  @param account Target account.
   *  @returns       Transaction receipt upon inclusion.
   */
  async grantRole(role: BytesLike, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.grantRole(role, account);
    return tx.wait();
  }

  /** Revoke a role (bytes32) from an account (DEFAULT_ADMIN_ROLE required).
   *  @param role    Role id (bytes32).
   *  @param account Target account.
   *  @returns       Transaction receipt upon inclusion.
   */
  async revokeRole(role: BytesLike, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.revokeRole(role, account);
    return tx.wait();
  }

  /** Renounce a role (bytes32) for the connected signer.
   *  @param role    Role id (bytes32).
   *  @param account Must match the connected signer.
   *  @returns       Transaction receipt upon inclusion.
   */
  async renounceRole(role: BytesLike, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.renounceRole(role, account);
    return tx.wait();
  }

  /** Check if `account` holds `role`.
   *  @param role    Role id (bytes32).
   *  @param account Address to check.
   *  @returns       True if the account has the role.
   */
  async hasRole(role: BytesLike, account: Address): Promise<boolean> {
    return this.contract.hasRole(role, account) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 7) Event Queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `WhitelistUpdated(user, level)` events. */
  async queryWhitelistUpdated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.WhitelistUpdated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `BatchWhitelistUpdated(count, level)` events. */
  async queryBatchWhitelistUpdated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.BatchWhitelistUpdated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `RootUpdated(oldRoot, newRoot)` events. */
  async queryRootUpdated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.RootUpdated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `VerifierSet(oldVerifier, newVerifier)` events. */
  async queryVerifierSet(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.VerifierSet);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `ZKAdded(user)` events. */
  async queryZKAdded(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.ZKAdded);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }
}

export default WhitelistHelper;
