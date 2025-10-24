/* ------------------------------------------------------------------ */
/*  KpiRegistryHelper — Developer-friendly wrapper for KpiRegistry    */
/* ------------------------------------------------------------------ */
/*  Overview
    - Matches KpiRegistry.sol (UUPS + ERC2771 + RolesCommon).
    - Adds thin, typed helpers for common flows:
        * deploy (proxy via factory), attach, connect
        * registerKpi, pushKpiValue, pause/unpause
        * views: kpiMeta, latestTimestamp, listProjectKpis
        * utils: bytes32 helpers, metricId derivation, event queries  */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
} from 'ethers';
import type { InterfaceAbi } from 'ethers';

import { KpiRegistry } from '../contracts/KpiRegistry'; // ↺ ABI bundle (TypeChain/abi-exporter style)
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from '../deployViaFactory';

/* ------------------------------------------------------------------ */
/*                             Types                                   */
/* ------------------------------------------------------------------ */

/** Canonical bytes32 hex string (0x + 64 hex chars). */
export type Address = string;
export type Bytes32 = string;

/** Result of deployment via factory. */
export interface DeployResult {
  address   : Address;                      // Proxy address
  receipt : ethers.TransactionReceipt;      // Deployment/initialize tx receipt
  helper  : KpiRegistryHelper;              // Connected helper
}

/** Solidity `struct Meta` mirrored in TS (see KpiRegistry.sol). */
export interface KpiMeta {
  projectId  : Bytes32;
  label      : string;
  decimals   : number;     // uint8
  compareMask: number;     // uint8 (bitwise OR of CompareMask)
  threshold  : bigint;     // uint256
  commitment : boolean;    // true = commitment/hash KPI (no numeric compare)
}

/** Solidity `struct MetricUpdate` in MultiTrustCredential (used by pushKpiValue). */
export interface MetricUpdate {
  metricId : Bytes32;              // KPI metric id
  newValue: bigint;                // uint256
  leafFull: ethers.BytesLike;      // bytes (full proof leaf or opaque payload)
  deadline: bigint;                // uint256 (epoch seconds)
}

export interface OptionalArgs {
  abi?: InterfaceAbi
}

/* ------------------------------------------------------------------ */
/*                         Compare Mask                                */
/* ------------------------------------------------------------------ */
/* Bitmask used for numeric KPI threshold evaluation in KpiRegistry.
   The mask is a bitwise OR of allowed comparisons on (value, threshold):
     - GTE (1): value ≥ threshold
     - LTE (2): value ≤ threshold
     - EQ  (4): value == threshold
   Predefined combos are provided for convenience.                    */

export const CompareMask = {
  NONE    : 0b000 as 0,
  GTE     : 0b001 as 1,
  LTE     : 0b010 as 2,
  EQ      : 0b100 as 4,
  RANGE   : 0b011 as 3,   // GTE | LTE  → threshold interpreted as a band (see on-chain semantics)
  FLOOR_EQ: 0b101 as 5,   // GTE | EQ
  CEIL_EQ : 0b110 as 6,   // LTE | EQ
  ALL     : 0b111 as 7,   // GTE | LTE | EQ (any)
} as const;

export type CompareMaskKey = keyof typeof CompareMask;

/* ------------------------------------------------------------------ */
/*                          Utilities                                  */
/* ------------------------------------------------------------------ */

/** True iff a string looks like a 0x-prefixed hex. */
const isHex = (v: string) => /^0x[0-9a-fA-F]*$/.test(v);

/** Left-pad a hex string (without 0x) to a fixed length with zeros. */
const lpadHex = (hexNo0x: string, bytes: number) =>
  hexNo0x.padStart(bytes * 2, '0');

/** Normalize into a proper bytes32:
 *  - If already 0x + 64 hex → returned as-is.
 *  - If 0x + ≤64 hex       → left-padded to 32 bytes.
 *  - If bigint/number      → hex-encode and left-pad to 32 bytes.
 *  - If ASCII string       → UTF-8 bytes right-padded with zeros and clipped to 32 bytes.
 *    (matches Solidity `bytes32("NAME")` semantics; NOT keccak hash)
 */
export function toBytes32(v: Bytes32 | bigint | number | string): Bytes32 {
  if (typeof v === 'string') {
    if (isHex(v)) {
      const body = v.slice(2);
      if (body.length === 64) return v as Bytes32;
      if (body.length < 64)   return (`0x${lpadHex(body, 32)}`) as Bytes32;
      // If longer than 32 bytes, clip right (Solidity bytes32 truncates).
      return (`0x${body.slice(0, 64)}`) as Bytes32;
    }
    // ASCII → bytes32 (UTF-8) padded with zeros (Solidity-like)
    const utf8 = ethers.toUtf8Bytes(v);
    const clipped = utf8.slice(0, 32);
    const packed  = new Uint8Array(32);
    packed.set(clipped, 0);
    return (ethers.hexlify(packed) as Bytes32);
  }
  const n = BigInt(v);
  return (`0x${n.toString(16).padStart(64, '0')}`) as Bytes32;
}

/** Keccak256(abi.encodePacked(projectId, label)) → deterministic metricId. */
export function deriveMetricId(projectId: Bytes32 | bigint | number | string, label: string): Bytes32 {
  const pid = toBytes32(projectId);
  // Using Solidity-compatible packed encoding: ["bytes32","string"]
  const id = ethers.solidityPackedKeccak256(['bytes32', 'string'], [pid, label]);
  return id as Bytes32;
}

/* ------------------------------------------------------------------ */
/*                           Events                                    */
/* ------------------------------------------------------------------ */
/* Event signatures (for queryFilter convenience). */
const EVT = {
  MetricRegistered: 'MetricRegistered(bytes32,bytes32,string)',
  MetricUpdated   : 'MetricUpdated(bytes32,uint256,uint256)',
  MetricPassed    : 'MetricPassed(bytes32,uint256,uint256)',
} as const;

/* ------------------------------------------------------------------ */
/*                             Helper                                  */
/* ------------------------------------------------------------------ */

export class KpiRegistryHelper {
  readonly address : string;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;
  readonly ops     : OptionalArgs | undefined;

  /** Internal constructor; use `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner, ops?: OptionalArgs) {
    this.address  = address;
    this.runner   = runner;

    this.ops = ops;
    this.contract = new ethers.Contract(this.address, ops?.abi? [...KpiRegistry.abi, ...ops.abi]: KpiRegistry.abi, runner);
  }

  /* ================================================================ */
  /* 1) Factory Deploy / Attach / Connect                             */
  /* ================================================================ */

  /** Attach an existing KpiRegistry at `address`. */
  static attach(address: Address, runner: ContractRunner, ops?: OptionalArgs): KpiRegistryHelper {
    return new KpiRegistryHelper(address, runner, ops);
  }

  /** Return a new helper with a different signer/runner. */
  connect(runner: ContractRunner): KpiRegistryHelper {
    if (runner === this.runner) return this;
    return new KpiRegistryHelper(this.address, runner, this.ops);
  }

  /** Deploy a new KpiRegistry proxy via your factory helper.
   *  - The underlying implementation will be initialized with:
   *      initialize(admin, mtcAddress, trustedForwarders)
   *  - `trustedForwarders` is the ERC-2771 trusted forwarders list.
   */
  static async deploy(
    {
      admin,
      mtcAddress,
      trustedForwarders,
    }: {
      admin: string;
      mtcAddress: string;
      trustedForwarders: readonly string[];
    },
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions,
      'contractType' | 'implABI' | 'initArgs' | 'signer'>>,
  ): Promise<DeployResult> {
    const res = await deployViaFactory({
      contractType : KpiRegistry.contractType,        // e.g., "KpiRegistry"
      implABI      : KpiRegistry.abi,
      initArgs     : [admin, mtcAddress, trustedForwarders],
      signer,
      ...(opts ?? {}),
    });

    const helper = new KpiRegistryHelper(res.address, signer);
    return { address: res.address, receipt: res.receipt, helper };
  }

  /* ================================================================ */
  /* 2) Writes (state-changing)                                        */
  /* ================================================================ */

  /** Register a KPI under a project and mirror registration in MTC.
   *  @param projectId   Project id (bytes32). Accepts bytes32/number/bigint/string.
   *                     - If string and not hex, will be encoded to bytes32 (UTF-8 padded).
   *  @param label       Human-readable label used in deterministic metricId.
   *  @param roleName    Bytes32 role name enforced by MTC for write permission.
   *                     - Pass a bytes32 hex (0x…) or ASCII which will be encoded to bytes32.
   *  @param decimals    Number of decimals for numeric KPIs (uint8 > 0).
   *  @param compare     Allowed comparisons (bit mask). You can pass:
   *                       - a key of CompareMask (e.g., 'GTE', 'RANGE', 'ALL'), or
   *                       - a numeric mask (0-7).
   *  @param threshold   Threshold for numeric evaluation (ignored if `commitment` is true).
   *  @param commitment  If true, treated as commitment/hash KPI (no numeric comparison).
   *  @returns           Transaction receipt. Emits `MetricRegistered`.
   *
   *  Solidity:
   *    function registerKpi(
   *      bytes32 projectId,
   *      string  label,
   *      bytes32 roleName,
   *      uint8   decimals,
   *      uint8   compareMask,
   *      uint256 threshold,
   *      bool    commitment
   *    ) external returns (bytes32 metricId);
   */
  async registerKpi(
    projectId : Bytes32 | bigint | number | string,
    label     : string,
    roleName  : Bytes32 | string,
    decimals  : number,
    compare   : CompareMaskKey | number,
    threshold : bigint,
    commitment: boolean,
  ): Promise<ethers.TransactionReceipt> {
    const pid   = toBytes32(projectId);
    const rname = toBytes32(roleName);
    const mask  = (typeof compare === 'number') ? compare : CompareMask[compare];

    const tx = await this.contract.registerKpi(
      pid, label, rname, decimals, mask, threshold, commitment,
    );
    return tx.wait();
  }

  /** Push a KPI value into MTC and record an epoch timestamp internally.
   *  - Caller must have ORACLE_ROLE on KpiRegistry/MTC side (as configured).
   *  - For numeric KPIs (commitment=false), a `MetricPassed` event is emitted
   *    when the new value satisfies the compareMask threshold.
   *  @param tokenId  Credential token id in MTC (often cast from holder address).
   *  @param update   MetricUpdate struct:
   *                    { metricId, newValue, leafFull, deadline }
   *  @returns        Transaction receipt. Emits `MetricUpdated` (+ optionally `MetricPassed`).
   *
   *  Solidity:
   *    function pushKpiValue(uint256 tokenId, MetricUpdate calldata upd) external;
   */
  async pushKpiValue(
    tokenId: bigint | number,
    update : MetricUpdate | {
      metricId : Bytes32 | bigint | number | string;
      newValue: bigint;
      leafFull: ethers.BytesLike;
      deadline: bigint;
    }
  ): Promise<ethers.TransactionReceipt> {
    const upd: MetricUpdate = {
      metricId : toBytes32(update.metricId as any),
      newValue : update.newValue,
      leafFull : update.leafFull,
      deadline : update.deadline,
    };

    const tx = await this.contract.pushKpiValue(
      BigInt(tokenId),
      upd,
    );
    return tx.wait();
  }

  /** Pause state-changing entrypoints; requires PAUSER_ROLE. */
  async pause(): Promise<ethers.TransactionReceipt> {
    const tx = await this.contract.pause();
    return tx.wait();
  }

  /** Unpause state-changing entrypoints; requires PAUSER_ROLE. */
  async unpause(): Promise<ethers.TransactionReceipt> {
    const tx = await this.contract.unpause();
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Views                                                          */
  /* ================================================================ */

  /** Fetch KPI meta by metricId. */
  async kpiMeta(metricId: Bytes32 | bigint | number | string): Promise<KpiMeta> {
    const meta = await this.contract.kpiMeta(toBytes32(metricId));
    // TypeChain could type this automatically; cast to our friendly interface:
    return {
      projectId  : meta.projectId as Bytes32,
      label      : meta.label as string,
      decimals   : Number(meta.decimals),
      compareMask: Number(meta.compareMask),
      threshold  : BigInt(meta.threshold),
      commitment : Boolean(meta.commitment),
    };
  }

  /** Latest epoch timestamp for a KPI (0 if none). */
  async latestTimestamp(metricId: Bytes32 | bigint | number | string): Promise<bigint> {
    return BigInt(await this.contract.latestTimestamp(toBytes32(metricId)));
  }

  /** List all KPI ids registered under a project. */
  async listProjectKpis(projectId: Bytes32 | bigint | number | string): Promise<Bytes32[]> {
    const arr = await this.contract.listProjectKpis(toBytes32(projectId));
    return arr as Bytes32[];
  }

  /* ================================================================ */
  /* 4) Event Queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `MetricRegistered` events. */
  async queryMetricRegistered(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.MetricRegistered);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `MetricUpdated` events. */
  async queryMetricUpdated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.MetricUpdated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }

  /** Query `MetricPassed` events. */
  async queryMetricPassed(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.MetricPassed);
    return this.contract.queryFilter(ev, from ?? 0, to ?? 'latest');
  }
}

/* ------------------------------------------------------------------ */
/*                               Notes                                 */
/* ------------------------------------------------------------------ */
/* 1) Param alignment with Solidity (.sol):
      - registerKpi uses `bytes32 roleName` (NOT "roleBytes").
      - compareMask is 0..7; use `CompareMask` keys for readability.
      - commitment=true → numeric evaluation is skipped on updates.
   2) ID helpers:
      - `toBytes32` will sensibly handle hex, numbers/bigints, and ASCII labels.
      - `deriveMetricId(projectId, label)` reproduces the on-chain metric id.
   3) Roles (from RolesCommon in .sol):
      - ADMIN_ROLE can register KPIs and authorize upgrades.
      - ORACLE_ROLE can push values (depending on MTC config).
      - PAUSER_ROLE can pause/unpause.
   4) Meta-tx:
      - Contract is ERC-2771 aware; pass `trustedForwarders` at deploy. */
