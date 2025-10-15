/* ------------------------------------------------------------------ */
/*  MetaGovernorHelper — Developer-friendly wrapper for MetaGovernor  */
/* ------------------------------------------------------------------ */
/*  Overview
    - Mirrors MetaGovernor.sol (Governor + Timelock + UUPS + ERC2771).
    - Exposes helpers for:
        * deploy (proxy via factory), attach, connect
        * propose (with ProposalType), finalize
        * views: state, proposalNeedsQueuing, votingDelay/Period, proposalThreshold
        * child passthroughs: getEconVotes, getSocVotes
        * config reads: econ(), soc(), timelock(), baseFactors/quorums/superRules
        * meta-tx admin: updateForwarder
        * utils: hashProposal (calls on-chain pure function)
        * events: Finalized       */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  TransactionReceipt,
} from "ethers";

import { MetaGovernor } from "../contracts/MetaGovernor"; // ↺ ABI bundle (TypeChain/abi-exporter)
import {
  deployViaFactory,
  DeployViaFactoryOptions
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;

export interface DeployArgs {
  /** DEFAULT_ADMIN_ROLE holder for MetaGovernor */
  admin: Address;
  /** Governor name (string used in EIP-712 domain) */
  name: string;
  /** Economic child governor address (must implement IGovernorBasic) */
  econ: Address;
  /** Social child governor address (must implement IGovernorBasic) */
  soc: Address;
  /** TimelockController address used by MetaGovernor */
  timelock: Address;
  /** ERC-2771 trusted forwarder list */
  trustedForwarders?: readonly Address[];
}

export interface DeployResult {
  /** Proxy address (use `res.address` from deployViaFactory) */
  address: Address;
  /** Deployment/initialize tx receipt */
  receipt: TransactionReceipt;
  /** Connected helper */
  helper: MetaGovernorHelper;
}

/* ── Solidity-side structs (public mappers) ───────────────────────── */

export interface Factors     { eco: number; soc: number; }          // uint16 bp each
export interface QuorumRule  { eco: number; soc: number; }          // uint16 bp each
export interface SuperRule   { yesBp: number; turnoutBp: number; }  // uint16 bp

/* ── Proposal type enum mapping (must match .sol order) ───────────── */

export const ProposalType = {
  Economic : 0,
  Social   : 1,
  Mixed    : 2,
  Emergency: 3,
} as const;
export type ProposalTypeKey = keyof typeof ProposalType;

/* ------------------------------------------------------------------ */
/*                              Events                                 */
/* ------------------------------------------------------------------ */
/* Match .sol exactly for queryFilter convenience. */
const EVT = {
  Finalized: "Finalized(uint256,uint256,uint256,address)",
} as const;

/* ------------------------------------------------------------------ */
/*                              Helper                                 */
/* ------------------------------------------------------------------ */

export class MetaGovernorHelper {
  readonly address : Address;
  readonly contract: ethers.Contract;
  readonly runner  : ContractRunner;

  public static ProposalType = ProposalType;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner) {
    this.address  = ethers.getAddress(address) as Address;
    this.runner   = runner;
    this.contract = new ethers.Contract(this.address, MetaGovernor.abi as InterfaceAbi, runner);
  }

  /* ================================================================ */
  /* 1) Factory deploy / attach / connect                              */
  /* ================================================================ */

  /** Deploy a new MetaGovernor proxy and return a connected helper. */
  static async deploy(
    args: DeployArgs,
    signer: ethers.Signer,
    opts?: Partial<Omit<DeployViaFactoryOptions, "contractType" | "implABI" | "initArgs" | "signer">>
  ): Promise<DeployResult> {
    const res = await deployViaFactory({
      contractType : MetaGovernor.contractType,   // e.g., "MetaGovernor"
      implABI      : MetaGovernor.abi,
      initArgs     : [
        args.admin,
        args.name,
        args.econ,
        args.soc,
        args.timelock,
        args.trustedForwarders ?? []
      ],
      signer,
      ...(opts ?? {}),
    });

    const helper = new MetaGovernorHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing MetaGovernor at `address`. */
  static attach(address: Address, runner: ContractRunner | ethers.Signer): MetaGovernorHelper {
    return new MetaGovernorHelper(address, runner);
  }

  /** Return a new helper bound to a different signer/runner. */
  connect(runner: ContractRunner | ethers.Signer): MetaGovernorHelper {
    if (runner === this.runner) return this;
    return new MetaGovernorHelper(this.address, runner);
  }

  /* ================================================================ */
  /* 2) Proposals & Finalization                                       */
  /* ================================================================ */

  /** Create a proposal on BOTH child governors with a shared id.
   *  @param p         Proposal type (affects combination/quorum/super rules).
   *  @param targets   Call targets.
   *  @param values    ETH amounts (wei) per call.
   *  @param calldatas Encoded calldata per call.
   *  @param desc      Human-readable description.
   *  @param startTs   Voting start timestamp (unix seconds).
   *  @param endTs     Voting end timestamp (unix seconds).
   *  @returns         The shared proposal id (same as `hashProposal(...)`).
   *
   *  On-chain checks:
   *    - `startTs < endTs` and `endTs > block.timestamp`.
   *    - `targets.length == values.length == calldatas.length`.
   *
   *  Solidity:
   *    function propose(
   *      ProposalType p,
   *      address[] targets,
   *      uint256[] values,
   *      bytes[]   calldatas,
   *      string    desc,
   *      uint64    startTs,
   *      uint64    endTs
   *    ) external returns (uint256 id);
   */
  async propose(
    p: ProposalTypeKey | number,
    targets: readonly Address[],
    values: readonly (bigint | number)[],
    calldatas: readonly ethers.BytesLike[],
    desc: string,
    startTs: bigint | number,
    endTs: bigint | number
  ): Promise<bigint> {
    const pt = (typeof p === "number" ? p : ProposalType[p]) as number;
    const tx = await this.contract.propose(
      pt,
      targets,
      values,
      calldatas,
      desc,
      startTs,
      endTs
    );
    const rc = await tx.wait();
    // The function returns `id`; ethers v6 allows reading the return via callStatic style,
    // but for a sent tx we recompute deterministically to avoid ABI nuances.
    return this.hashProposal({ targets, values, calldatas, description: desc });
  }

  /** Finalize after BOTH children are `Succeeded` and combined rules pass. */
  async finalize(id: bigint | number): Promise<TransactionReceipt> {
    const tx = await this.contract.finalize(id);
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Views (MetaGovernor)                                           */
  /* ================================================================ */

  /** Governor state (MetaGovernor’s view). */
  async state(id: bigint | number): Promise<number> {
    return this.contract.state(id).then(Number);
  }

  /** Whether proposals require queuing (timelock). */
  async proposalNeedsQueuing(id: bigint | number): Promise<boolean> {
    return this.contract.proposalNeedsQueuing(id) as Promise<boolean>;
  }

  /** Voting delay placeholder (meta uses children windows). */
  async votingDelay(): Promise<bigint> {
    return this.contract.votingDelay().then(BigInt);
  }

  /** Voting period placeholder (meta uses children windows). */
  async votingPeriod(): Promise<bigint> {
    return this.contract.votingPeriod().then(BigInt);
  }

  /** Proposal threshold passthrough (from Governor base). */
  async proposalThreshold(): Promise<bigint> {
    return this.contract.proposalThreshold().then(BigInt);
  }

  /** Read addresses configured on meta. */
  async econ(): Promise<Address> { return (await this.contract.econ()) as Address; }
  async soc(): Promise<Address>  { return (await this.contract.soc())  as Address; }

  /** Timelock controller address (inherited getter). */
  async timelock(): Promise<Address> {
    return (await this.contract.timelock()) as Address;
  }

  /** Base combination factors for a proposal type (bp each for eco/soc YES/NO). */
  async baseFactorsOf(p: ProposalTypeKey | number): Promise<Factors> {
    const pt = (typeof p === "number" ? p : ProposalType[p]) as number;
    const v  = await this.contract.baseFactors(pt);
    return { eco: Number(v.eco ?? v[0]), soc: Number(v.soc ?? v[1]) };
  }

  /** Child turnout quorum (bp of each child total supply). */
  async quorumRuleOf(p: ProposalTypeKey | number): Promise<QuorumRule> {
    const pt = (typeof p === "number" ? p : ProposalType[p]) as number;
    const v  = await this.contract.quorums(pt);
    return { eco: Number(v.eco ?? v[0]), soc: Number(v.soc ?? v[1]) };
  }

  /** Super-majority rule: YES-share threshold and combined turnout threshold. */
  async superRuleOf(p: ProposalTypeKey | number): Promise<SuperRule> {
    const pt = (typeof p === "number" ? p : ProposalType[p]) as number;
    const v  = await this.contract.superRules(pt);
    return { yesBp: Number(v.yesBp ?? v[0]), turnoutBp: Number(v.turnoutBp ?? v[1]) };
  }

  /* ================================================================ */
  /* 4) Child passthroughs (votes)                                     */
  /* ================================================================ */

  /** Economic child voting power at `timepoint`. */
  async getEconVotes(account: Address, timepoint: bigint | number): Promise<bigint> {
    return this.contract.getEconVotes(account, timepoint).then(BigInt);
  }

  /** Social child voting power at `timepoint`. */
  async getSocVotes(account: Address, timepoint: bigint | number): Promise<bigint> {
    return this.contract.getSocVotes(account, timepoint).then(BigInt);
  }

  /* ================================================================ */
  /* 5) Meta-tx / Admin                                                */
  /* ================================================================ */

  /** Add/remove a trusted ERC-2771 forwarder. Requires DEFAULT_ADMIN_ROLE. */
  async updateForwarder(forwarder: Address, trust: boolean): Promise<TransactionReceipt> {
    const tx = await this.contract.updateForwarder(forwarder, trust);
    return tx.wait();
  }

  /** ERC165 interface support (aggregated across parents). */
  async supportsInterface(iid: string): Promise<boolean> {
    return this.contract.supportsInterface(iid) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 6) Utilities                                                      */
  /* ================================================================ */

  /** On-chain, pure proposal id computation (matches MetaGovernor.sol). */
  async hashProposal(args: {
    targets: readonly Address[];
    values:  readonly (bigint | number)[];
    calldatas: readonly ethers.BytesLike[];
    description: string;
  }): Promise<bigint> {
    const descHash = ethers.keccak256(ethers.toUtf8Bytes(args.description));
    const id = await this.contract.hashProposal(args.targets, args.values, args.calldatas, descHash);
    return BigInt(id);
  }

  /* ================================================================ */
  /* 7) Event queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `Finalized(id, yes, no, sender)` events. */
  async queryFinalized(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.Finalized);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }
}

export default MetaGovernorHelper;
