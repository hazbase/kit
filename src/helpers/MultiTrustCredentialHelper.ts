/* ------------------------------------------------------------------ */
/*  MultiTrustCredentialHelper — Developer-friendly wrapper            */
/* ------------------------------------------------------------------ */
/*  Overview
    - Mirrors MultiTrustCredential.sol (UUPS, ERC721, ERC2771, RolesCommon, Pausable).
    - Exposes typed helpers for:
        * deploy (proxy via factory), attach, connect
        * registerMetric, setCompareMask
        * mint / mintBatch, updateMetric / updateMetricBatch, proveMetric, slash
        * pause / unpause
        * views: metricRole, metricLabel, isCommitmentMetric, compareMask, verifier
        * event queries: MetricRegistered, MetricUpdated, Slash, VerifierSet         */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  TransactionReceipt
} from 'ethers';

import { MultiTrustCredential as MTC } from '../contracts/MultiTrustCredential';
import {
  deployViaFactory,
  DeployViaFactoryOptions
} from '../deployViaFactory';
import { DEFAULT_VERIFIER_ADDRESSES } from '../constants';

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;
export type Bytes32 = string;

/** Deploy-time arguments mapped to MultiTrustCredential.initialize(...) */
export interface DeployArgs {
  admin: Address;                   // DEFAULT_ADMIN_ROLE holder
  trustedForwarders?: readonly Address[]; // ERC-2771 forwarders
}

/** Result of deployment via factory. */
export interface DeployResult {
  address: Address;                 // Proxy address (use res.address)
  receipt: TransactionReceipt;      // Deployment/initialize tx receipt
  helper : MultiTrustCredentialHelper; // Connected helper
}

/** Struct mirrors (see .sol) */
export interface MetricInputStruct {
  /** bytes32 metric id */
  metricId: Bytes32 | string;
  /** uint32 value (use number ≤ 2^32-1 or bigint) */
  value: number | bigint;
  /** uint256 anchor root stored on-chain (maps to Metric.leafFull) */
  anchorRoot?: bigint;
  /** @deprecated Use anchorRoot. */
  leafFull?: bigint;
  /** tokenURI for new token (empty string allowed) */
  uri?: string;
  /** expire date time for metric */
  expiresAt?: bigint;
}

export interface MintItemStruct {
  to: Address;
  metricId: Bytes32 | string;
  value: number | bigint;
  anchorRoot?: bigint;
  /** @deprecated Use anchorRoot. */
  leafFull?: bigint;
  uri?: string;
  expiresAt?: bigint;
}

export interface MetricUpdateStruct {
  metricId: Bytes32 | string;
  newValue: number | bigint; // uint32
  anchorRoot?: bigint;       // uint256 (stored on-chain as leafFull)
  /** @deprecated Use anchorRoot. */
  leafFull?: bigint;
  expiresAt?: bigint;
}

export interface UpdateItemStruct {
  tokenId: bigint;
  metricId: Bytes32 | string;
  newValue: number | bigint; // uint32
  anchorRoot?: bigint;       // uint256 (stored on-chain as leafFull)
  /** @deprecated Use anchorRoot. */
  leafFull?: bigint;
  expiresAt?: bigint;
}

export interface OptionalArgs {
  abi?: InterfaceAbi
}

export interface ProofRoleGrant {
  roleName: Bytes32 | string;
  account: Address;
}

export interface ProofReadinessIssue {
  code: 'verifier_not_set' | 'missing_role';
  message: string;
  roleName?: Bytes32;
  account?: Address;
}

export interface ProofReadiness {
  ready: boolean;
  verifier: Address;
  issues: ProofReadinessIssue[];
}

/* ------------------------------------------------------------------ */
/*                         Compare Mask (bit flags)                   */
/* ------------------------------------------------------------------ */
/* Matches CompareMask in .sol: GT=1, LT=2, EQ=4. OR-combinations allowed. */
export const CompareMask = {
  GT  : 1 << 0 as 1,
  LT  : 1 << 1 as 2,
  EQ  : 1 << 2 as 4,
  
  NONE: 0 as 0,
  
  NEQ : 3 as 3, // GT | LT
  GTE : 5 as 5, // GT | EQ
  LTE : 6 as 6, // LT | EQ
  ALL : 7 as 7  // GT | LT | EQ
} as const;

export type CompareMaskKey = keyof typeof CompareMask;

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;

/* ------------------------------------------------------------------ */
/*                           Utilities                                 */
/* ------------------------------------------------------------------ */

/** Convert various inputs into a canonical bytes32 (0x + 64 hex). */
export function toBytes32(v: Bytes32 | string | number | bigint): Bytes32 {
  if (typeof v === 'string') {
    if (/^0x[0-9a-fA-F]*$/.test(v)) {
      const body = v.slice(2);
      if (body.length === 64) return v as Bytes32;
      if (body.length < 64) return (`0x${body.padStart(64, '0')}`) as Bytes32;
      return (`0x${body.slice(0, 64)}`) as Bytes32;
    }
    // UTF-8 → bytes32 (right-padded with zeros)
    const bytes = ethers.toUtf8Bytes(v);
    const buf = new Uint8Array(32);
    buf.set(bytes.slice(0, 32), 0);
    return ethers.hexlify(buf) as Bytes32;
  }
  const n = BigInt(v);
  return (`0x${n.toString(16).padStart(64, '0')}`) as Bytes32;
}

/* ------------------------------------------------------------------ */
/*                              Events                                 */
/* ------------------------------------------------------------------ */
/* Names/ABIs must match .sol exactly for queryFilter convenience.     */
const EVT = {
  MetricRegistered: 'MetricRegistered(bytes32,string,bytes32,uint8)',
  MetricUpdated   : 'MetricUpdated(uint256,bytes32,uint32,uint256)',
  Slash           : 'Slash(uint256,bytes32,uint32)',
  VerifierSet     : 'VerifierSet(address)',
} as const;

/* ------------------------------------------------------------------ */
/*                              Helper                                 */
/* ------------------------------------------------------------------ */

export class MultiTrustCredentialHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;
  readonly ops     : OptionalArgs | undefined;

  public static CompareMask = CompareMask;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner, ops?: OptionalArgs) {
    this.address  = ethers.getAddress(address) as Address;
    this.runner   = runner;

    this.ops = ops;
    this.contract = new ethers.Contract(this.address, ops?.abi? [...MTC.abi, ...ops.abi]: MTC.abi, runner);
  }

  /* ================================================================ */
  /* 1) Factory Deploy / Attach / Connect                             */
  /* ================================================================ */

  /** Deploy a new MTC proxy via your factory helper.
   *  - Initializes with: `initialize(admin, verifier, forwarders)`.
   */
  static async deploy(
    args: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions, 'contractType' | 'implABI' | 'initArgs' | 'signer'>>
  ): Promise<DeployResult> {
    
    const res = await deployViaFactory({
      contractType : MTC.contractType,
      implABI      : MTC.abi,
      initArgs     : [ args.admin, args.trustedForwarders ?? [] ],
      signer,
      ...(opts ?? {}),
    });

    const helper = new MultiTrustCredentialHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach an existing MTC at `address`. */
  static attach(address: Address, runner: ContractRunner, ops?: OptionalArgs): MultiTrustCredentialHelper {
    return new MultiTrustCredentialHelper(address, runner, ops);
  }

  /** Return a new helper bound to a different runner/signer. */
  connect(runner: ContractRunner): MultiTrustCredentialHelper {
    if (runner === this.runner) return this;
    return new MultiTrustCredentialHelper(this.address, runner, this.ops);
  }

  /* ================================================================ */
  /* 2) Metric Registry                                               */
  /* ================================================================ */

  /** Register a new metric type.
   *  @param id          Metric id (bytes32).
   *  @param label       Human-readable label.
   *  @param roleName    Writer role (bytes32) required for mint/update.
   *  @param commitment  If true, commitment/hash semantics for value.
   *  @param mask        Allowed compare ops (0..7). Use `CompareMask` keys or numeric.
   *  @returns           Transaction receipt. Emits `MetricRegistered`.
   *
   *  Solidity:
   *    function registerMetric(bytes32 id, string label, bytes32 roleName, bool commitment, uint8 mask)
   *      external onlyRole(ADMIN_ROLE);
   */
  async registerMetric(
    id         : Bytes32 | string,
    label      : string,
    roleName   : Bytes32 | string,
    commitment : boolean,
    mask       : CompareMaskKey | number,
  ): Promise<TransactionReceipt> {
    const mid  = toBytes32(id);
    const role = toBytes32(roleName);
    const msk  = typeof mask === 'number' ? mask : CompareMask[mask];
    const tx   = await this.contract.registerMetric(mid, label, role, commitment, msk);
    return tx.wait();
  }

  /** Update compare mask for a metric (writer role required).
   *  @param id   Metric id.
   *  @param mask New mask (0..7).
   *  @returns    Transaction receipt.
   *
   *  Solidity:
   *    function setCompareMask(bytes32 id, uint8 mask) external whenNotPaused;
   */
  async setCompareMask(id: Bytes32 | string, mask: CompareMaskKey | number): Promise<TransactionReceipt> {
    const mid = toBytes32(id);
    const msk = typeof mask === 'number' ? mask : CompareMask[mask];
    const tx  = await this.contract.setCompareMask(mid, msk);
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Mint / Update                                                 */
  /* ================================================================ */

  /** Mint credential (if absent) and set a metric in one call.
   *  @param to     Token owner address (tokenId = uint160(to)).
   *  @param input  MetricInputStruct.
   *  @returns      Transaction receipt. Emits `MetricUpdated`.
   *
   *  Solidity:
   *    function mint(address to, MetricInput calldata data)
   *      external whenNotPaused nonReentrant;
   */
  async mint(to: Address, input: MetricInputStruct): Promise<TransactionReceipt> {
    const anchorRoot = (input.anchorRoot ?? input.leafFull);
    if (anchorRoot == null) throw new Error("anchorRoot is required");

    const payload = {
      metricId : toBytes32(input.metricId),
      value    : input.value,
      leafFull : anchorRoot,
      uri      : input.uri ?? '',
      expiresAt: input.expiresAt ?? 0
    };
    const tx = await this.contract.mint(to, payload);
    return tx.wait();
  }

  /** Batch mint and/or write metrics.
   *  @param arr  Array of MintItemStruct.
   *  @returns    Transaction receipt. Emits `MetricUpdated` per item.
   *
   *  Solidity:
   *    function mintBatch(MintItem[] calldata arr)
   *      external whenNotPaused nonReentrant;
   */
  async mintBatch(arr: MintItemStruct[]): Promise<TransactionReceipt> {
    const payload = arr.map(i => ({
      to       : i.to,
      metricId : toBytes32(i.metricId),
      value    : i.value,
      leafFull : (i.anchorRoot ?? i.leafFull),
      uri      : i.uri ?? '',
      expiresAt: i.expiresAt ?? 0
    }));
    const tx = await this.contract.mintBatch(payload);
    return tx.wait();
  }

  /** Update a metric for an existing token.
   *  @param tokenId Token id (uint256).
   *  @param upd     MetricUpdateStruct.
   *  @returns       Transaction receipt. Emits `MetricUpdated`.
   *
   *  Solidity:
   *    function updateMetric(uint256 tokenId, MetricUpdate calldata upd)
   *      external whenNotPaused nonReentrant;
   */
  async updateMetric(tokenId: bigint, upd: MetricUpdateStruct): Promise<TransactionReceipt> {
    const anchorRoot = (upd.anchorRoot ?? upd.leafFull);
    if (anchorRoot == null) throw new Error("anchorRoot is required");
    const payload = {
      metricId: toBytes32(upd.metricId),
      newValue: upd.newValue,
      leafFull: anchorRoot,
      expiresAt: upd.expiresAt ?? 0
    };
    const tx = await this.contract.updateMetric(tokenId, payload);
    return tx.wait();
  }

  /** Batch update metrics.
   *  @param arr  Array of UpdateItemStruct.
   *  @returns    Transaction receipt. Emits `MetricUpdated` per item.
   *
   *  Solidity:
   *    function updateMetricBatch(UpdateItem[] calldata arr)
   *      external whenNotPaused nonReentrant;
   */
  async updateMetricBatch(arr: UpdateItemStruct[]): Promise<TransactionReceipt> {
    const payload = arr.map(i => ({
      tokenId : i.tokenId,
      metricId: toBytes32(i.metricId),
      newValue: i.newValue,
      leafFull: (i.anchorRoot ?? i.leafFull),
      expiresAt: i.expiresAt ?? 0
    }));
    const tx = await this.contract.updateMetricBatch(payload);
    return tx.wait();
  }

  /* ================================================================ */
  /* 4) Proof / Moderation                                            */
  /* ================================================================ */

  async updateVerifier(_verifier?: Address): Promise<TransactionReceipt> {
    let verifier: Address;
    if (_verifier) {
      verifier = _verifier;
    } else {
      const provider = this.runner.provider;
      if (!provider) throw new Error('Signer must have a provider');

      const chainId = Number((await provider.getNetwork()).chainId);
      verifier = DEFAULT_VERIFIER_ADDRESSES[chainId].default;
    }
    const tx = await this.contract.updateVerifier(verifier);
    return tx.wait();
  }


  async getProofReadiness(requiredGrants: readonly ProofRoleGrant[] = []): Promise<ProofReadiness> {
    const verifier = await this.verifier();
    const issues: ProofReadinessIssue[] = [];

    if (verifier === ZERO_ADDR) {
      issues.push({
        code: 'verifier_not_set',
        message: 'Verifier is not configured on MultiTrustCredential.',
      });
    }

    for (const grant of requiredGrants) {
      const role = toBytes32(grant.roleName);
      const account = ethers.getAddress(grant.account);
      const ok = await this.contract.hasRole(role, account);
      if (!ok) {
        issues.push({
          code: 'missing_role',
          message: `Missing writer role ${role} for ${account}.`,
          roleName: role,
          account,
        });
      }
    }

    return {
      ready: issues.length === 0,
      verifier,
      issues,
    };
  }

  async assertProofReadiness(requiredGrants: readonly ProofRoleGrant[] = []): Promise<void> {
    const readiness = await this.getProofReadiness(requiredGrants);
    if (!readiness.ready) {
      throw new Error(readiness.issues.map((issue) => issue.message).join(' '));
    }
  }

  async configureProofFlow({
    verifier,
    roleGrants = [],
  }: {
    verifier?: Address;
    roleGrants?: readonly ProofRoleGrant[];
  }): Promise<{ verifierReceipt?: TransactionReceipt; roleReceipts: TransactionReceipt[]; readiness: ProofReadiness }> {
    let verifierReceipt: TransactionReceipt | undefined;
    if (verifier) {
      verifierReceipt = await this.updateVerifier(verifier);
    }

    const roleReceipts: TransactionReceipt[] = [];
    for (const grant of roleGrants) {
      const role = toBytes32(grant.roleName);
      const account = ethers.getAddress(grant.account);
      const has = await this.contract.hasRole(role, account);
      if (!has) {
        const tx = await this.contract.grantRole(role, account);
        roleReceipts.push(await tx.wait());
      }
    }

    const readiness = await this.getProofReadiness(roleGrants);
    return { verifierReceipt, roleReceipts, readiness };
  }

  /** Verify a zk proof against stored metric / mask rules.
   *  @returns bool (true if verifier returns true and on-chain checks pass).
   *
   *  Solidity:
   *    function proveMetric(
   *      uint256 tokenId,
   *      bytes32 metricId,
   *      uint256[2] calldata a,
   *      uint256[2][2] calldata b,
   *      uint256[2] calldata c,
   *      uint256[6] calldata pubSignals
   *    ) external view whenNotPaused returns (bool);
   */
  async proveMetric(
    tokenId: bigint,
    metricId: Bytes32 | string,
    a: readonly [string, string],
    b: readonly [[string, string], [string, string]],
    c: readonly [string, string],
    pubSignals: readonly [bigint, bigint, bigint, bigint, bigint, bigint]
  ): Promise<boolean> {
    return this.contract.proveMetric(
      tokenId,
      toBytes32(metricId),
      a, b, c, pubSignals
    ) as Promise<boolean>;
  }

  async proveGroupMetric(
    tokenId: bigint,
    metricId: Bytes32 | string,
    a: readonly [string, string],
    b: readonly [[string, string], [string, string]],
    c: readonly [string, string],
    pubSignals: readonly [bigint, bigint, bigint, bigint, bigint, bigint]
  ): Promise<boolean> {
    return this.contract.proveGroupMetric(
      tokenId,
      toBytes32(metricId),
      a, b, c, pubSignals
    ) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 6) ZKEx Predicates (ALLOWLIST / RANGE / DELTA)                    */
  /* ================================================================ */

  /** Predicate type helpers (keccak256("...") / bytes32). */
  public static PredicateType = {
    ALLOWLIST: ethers.id("ALLOWLIST") as Bytes32,
    RANGE    : ethers.id("RANGE") as Bytes32,
    DELTA    : ethers.id("DELTA") as Bytes32,
  } as const;

  /** Convert a predicate label or bytes32 into the on-chain predicateType (bytes32 keccak). */
  static toPredicateType(v: Bytes32 | string): Bytes32 {
    if (typeof v === 'string' && v.startsWith('0x') && v.length === 66) {
      return v as Bytes32;
    }
    // Treat non-0x strings as labels hashed with keccak256.
    return ethers.id(String(v)) as Bytes32;
  }

  /** Enable/disable a predicate for a metric (ADMIN_ROLE required). */
  async setPredicateAllowed(
    metricId: Bytes32 | string,
    predicateType: Bytes32 | string,
    allowed: boolean
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.setPredicateAllowed(
      toBytes32(metricId),
      MultiTrustCredentialHelper.toPredicateType(predicateType),
      allowed
    );
    return tx.wait();
  }

  /** Set predicate verification profile (ADMIN_ROLE required). */
  async setPredicateProfile(
    metricId: Bytes32 | string,
    predicateType: Bytes32 | string,
    predVerifier: Address,
    signalsLen: number,
    anchorIndex: number,
    addrIndex: number,
    epochIndex: number,
    epochCheck: boolean,
    requireMaskZero: boolean
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.setPredicateProfile(
      toBytes32(metricId),
      MultiTrustCredentialHelper.toPredicateType(predicateType),
      predVerifier,
      signalsLen,
      anchorIndex,
      addrIndex,
      epochIndex,
      epochCheck,
      requireMaskZero
    );
    return tx.wait();
  }

  /** Set predicate epoch/version (ADMIN_ROLE required). */
  async setPredicateEpoch(
    metricId: Bytes32 | string,
    predicateType: Bytes32 | string,
    epoch: bigint
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.setPredicateEpoch(
      toBytes32(metricId),
      MultiTrustCredentialHelper.toPredicateType(predicateType),
      epoch
    );
    return tx.wait();
  }

  /** Prove an arbitrary predicate (ZKEx). Proof must be Groth16-style (a,b,c). */
  async provePredicate(
    tokenId: bigint,
    metricId: Bytes32 | string,
    predicateType: Bytes32 | string,
    proof: { a: readonly [string, string], b: readonly [[string, string], [string, string]], c: readonly [string, string] },
    publicSignals: readonly bigint[]
  ): Promise<boolean> {
    const proofBytes = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]","uint256[2][2]","uint256[2]"],
      [proof.a, proof.b, proof.c]
    );

    return this.contract.provePredicate(
      tokenId,
      toBytes32(metricId),
      MultiTrustCredentialHelper.toPredicateType(predicateType),
      proofBytes,
      publicSignals
    ) as Promise<boolean>;
  }

  /** Slash (reduce) a numeric metric for an offender (SLASHER_ROLE required).
   *  @param offender Address to slash (tokenId = uint160(offender)).
   *  @param metricId Metric type id.
   *  @param penalty  Amount to subtract (uint32 > 0).
   *  @returns        Transaction receipt. Emits `Slash`.
   *
   *  Solidity:
   *    function slash(address offender, bytes32 metricId, uint32 penalty)
   *      external onlyRole(SLASHER_ROLE);
   */
  async slash(offender: Address, metricId: Bytes32 | string, penalty: number | bigint): Promise<TransactionReceipt> {
    const tx = await this.contract.slash(offender, toBytes32(metricId), penalty);
    return tx.wait();
  }

  /* ================================================================ */
  /* 5) Pausable                                                      */
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
  /* 6) Views                                                         */
  /* ================================================================ */

  /** Read writer role (bytes32) for a metric id. */
  async metricRoleOf(metricId: Bytes32 | string): Promise<Bytes32> {
    return this.contract.metricRole(toBytes32(metricId)) as Promise<Bytes32>;
  }

  /** Read human-readable label for a metric id. */
  async metricLabelOf(metricId: Bytes32 | string): Promise<string> {
    return this.contract.metricLabel(toBytes32(metricId)) as Promise<string>;
  }

  /** True if the metric is marked as commitment-only. */
  async isCommitment(metricId: Bytes32 | string): Promise<boolean> {
    return this.contract.isCommitmentMetric(toBytes32(metricId)) as Promise<boolean>;
  }

  /** Compare mask (0..7) for a metric id. */
  async compareMaskOf(metricId: Bytes32 | string): Promise<number> {
    const v = await this.contract.compareMask(toBytes32(metricId));
    return Number(v);
  }

  /** Current zk verifier address (public variable). */
  async verifier(): Promise<Address> {
    return (await this.contract.verifier()) as Address;
  }

  /* ================================================================ */
  /* 7) Event Queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `MetricRegistered(id,label,role,mask)` events. */
  async queryMetricRegistered(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.MetricRegistered);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `MetricUpdated(tokenId,metricId,newValue,leafFull)` events. */
  async queryMetricUpdated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.MetricUpdated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `Slash(tokenId,metricId,penalty)` events. */
  async querySlash(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Slash);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `VerifierSet(verifier)` events (emitted on initialize). */
  async queryVerifierSet(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.VerifierSet);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /* ================================================================ */
  /* 8) Role helpers (optional conveniences)                          */
  /* ================================================================ */

  /** Grant a role (bytes32) to an account. Requires DEFAULT_ADMIN_ROLE. */
  async grantRole(role: Bytes32 | string, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.grantRole(toBytes32(role), account);
    return tx.wait();
  }

  /** Revoke a role (bytes32) from an account. Requires DEFAULT_ADMIN_ROLE. */
  async revokeRole(role: Bytes32 | string, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.revokeRole(toBytes32(role), account);
    return tx.wait();
  }

  /** Renounce a role (bytes32) for the connected signer (self). */
  async renounceRole(role: Bytes32 | string, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.renounceRole(toBytes32(role), account);
    return tx.wait();
  }

  /** Check if `account` holds `role`. */
  async hasRole(role: Bytes32 | string, account: Address): Promise<boolean> {
    return this.contract.hasRole(toBytes32(role), account) as Promise<boolean>;
  }

  /* ================================================================ */
  /* Utils                                                            */
  /* ================================================================ */

  /** Deterministic tokenId convention used on-chain: uint256(uint160(owner)). */
  static tokenIdFor(owner: Address): bigint {
    return BigInt(owner);
  }
}

export default MultiTrustCredentialHelper;
