/* ------------------------------------------------------------------ */
/*  GenericGovernorHelper — Timestamped Governor (Timelock-backed)    */
/* ------------------------------------------------------------------ */

import {
  ethers,
  ContractRunner,
  InterfaceAbi,
  BytesLike,
  TransactionReceipt,
} from "ethers";

import { GenericGovernor } from "../contracts/GenericGovernor";
import {
  deployViaFactory,
  DeployViaFactoryOptions,
} from "../deployViaFactory";

/* ------------------------------------------------------------------ */
/*                               Types                                 */
/* ------------------------------------------------------------------ */

export type Address = string;
export type Bytes32 = string;

/** Deploy-time arguments mapped to GenericGovernor.initialize(...) */
export interface DeployArgs {
  /** Admin with DEFAULT_ADMIN_ROLE (and Governor admin) */
  admin: Address;
  /** Governor name (used for EIP-712 domain separator) */
  name: string;
  /** IVotes-compliant token (e.g., ERC20Votes) */
  token: Address;
  /** TimelockController (upgradeable) used by this Governor */
  timelock: Address;
  /** IWeightStrategy implementation for vote weights/quorum/threshold */
  strategyAddr: Address;
  /** ERC-2771 trusted forwarders (can be empty) */
  trustedForwarders?: readonly Address[];
}

/** Deploy result (uses `res.address`, not `res.proxy`) */
export interface DeployResult {
  address: Address;
  receipt: TransactionReceipt;
  helper: GenericGovernorHelper;
}

/** Extended propose() arguments (matches the custom .sol overload) */
export interface ProposalArgs {
  proposer: Address;
  targets: readonly Address[];
  values: readonly (bigint | number)[];
  calldatas: readonly BytesLike[];
  description: string;
  /** UNIX seconds (0 ⇒ start immediately) */
  startTs: bigint | number;
  /** UNIX seconds (must be > startTs, ≤ startTs + 60 days) */
  endTs: bigint | number;
}

/** Tuple returned by `getProposalDetails(id)` */
export interface ProposalDetails {
  proposer: Address;
  targets: Address[];
  values: bigint[];
  calldatas: string[]; // hex-encoded
  start: bigint;
  end: bigint;
  description: string;
}

/** Enum mirror of `Origin` in .sol (proposalOrigin mapping) */
export enum Origin {
  Standalone = 0,
  Meta = 1,
}

/* ------------------------------------------------------------------ */
/*                               Events                                */
/* ------------------------------------------------------------------ */

const EVT = {
  ProposalCreated: "ProposalCreated",
  ProposalQueued: "ProposalQueued",
  ProposalExecuted: "ProposalExecuted",
  VoteCast: "VoteCast",
  DefaultStrategySet: "DefaultStrategySet(bytes4,address)",
} as const;

/* ------------------------------------------------------------------ */
/*                               Helper                                */
/* ------------------------------------------------------------------ */

export class GenericGovernorHelper {
  readonly address: Address;
  readonly contract: ethers.Contract;
  readonly runner: ContractRunner;

  /** Internal constructor; prefer `attach` or `deploy`. */
  private constructor(address: Address, runner: ContractRunner) {
    this.address = ethers.getAddress(address) as Address;
    this.runner = runner;
    this.contract = new ethers.Contract(
      this.address,
      GenericGovernor.abi as InterfaceAbi,
      runner
    );
  }

  /* ================================================================ */
  /* 1) Deploy / Attach / Connect                                      */
  /* ================================================================ */

  /** Deploy a new Governor proxy and return a connected helper. */
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
      contractType: GenericGovernor.contractType, // e.g., "GenericGovernor"
      implABI: GenericGovernor.abi,
      initArgs: [
        args.admin,
        args.name,
        args.token,
        args.timelock,
        args.strategyAddr,
        args.trustedForwarders ?? [],
      ],
      signer,
      ...(opts ?? {}),
    });

    const helper = new GenericGovernorHelper(res.address as Address, signer);
    return { address: res.address as Address, receipt: res.receipt, helper };
  }

  /** Attach to an existing Governor proxy at `address`. */
  static attach(
    address: Address,
    runner: ContractRunner | ethers.Signer
  ): GenericGovernorHelper {
    return new GenericGovernorHelper(address, runner);
  }

  /** Return a new helper bound to a different signer/runner. */
  connect(runner: ContractRunner | ethers.Signer): GenericGovernorHelper {
    if (runner === this.runner) return this;
    return new GenericGovernorHelper(this.address, runner);
  }

  /* ================================================================ */
  /* 2) Proposals (create/queue/execute/cancel)                        */
  /* ================================================================ */

  /** Create a proposal with explicit voting window (extended overload).
   *  @returns Proposal id (deterministic; computed via on-chain `hashProposal`)
   *
   *  Solidity:
   *    function propose(
   *      address proposer,
   *      address[] targets,
   *      uint256[] values,
   *      bytes[]   calldatas,
   *      string    description,
   *      uint64    startTs,
   *      uint64    endTs
   *    ) public returns (uint256 id);
   */
  async propose(p: ProposalArgs): Promise<bigint> {
    const tx = await this.contract.propose(
      p.proposer,
      p.targets,
      p.values,
      p.calldatas,
      p.description,
      p.startTs,
      p.endTs
    );
    await tx.wait();
    // Derive the same id as the contract by calling the pure hasher.
    return this.hashProposal({
      targets: p.targets,
      values: p.values,
      calldatas: p.calldatas,
      description: p.description,
    });
  }

  /** Mirror a proposal from a parent (Meta) into this child (requires META_ROLE).
   *  @returns The shared id (reverts on mismatch as per .sol)
   *
   *  Solidity:
   *    function proposeChild(
   *      uint256 sharedId,
   *      address proposer,
   *      address[] targets,
   *      uint256[] values,
   *      bytes[]   calldatas,
   *      string    description,
   *      uint64 startTs,
   *      uint64 endTs
   *    ) external onlyRole(META_ROLE) returns (uint256);
   */
  async proposeChild(
    sharedId: bigint | number,
    p: ProposalArgs
  ): Promise<bigint> {
    const tx = await this.contract.proposeChild(
      sharedId,
      p.proposer,
      p.targets,
      p.values,
      p.calldatas,
      p.description,
      p.startTs,
      p.endTs
    );
    const rc = await tx.wait();
    // If tx succeeded, the function already ensured equality; return sharedId.
    return BigInt(sharedId);
  }

  /** Queue the proposal into the Timelock (GovernorTimelockControl).
   *  @returns ETA (if emitted via ProposalQueued)
   *
   *  Solidity:
   *    function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash)
   *      external returns (uint256 proposalId);
   */
  async queue(proposalId: bigint | number): Promise<bigint | null> {
    const { targets, values, calldatas, description } =
      await this.getProposalDetails(proposalId);
    const dh = GenericGovernorHelper.descriptionHash(description);
    const tx = await this.contract.queue(targets, values, calldatas, dh);
    const rc = await tx.wait();

    // Try to extract ETA from `ProposalQueued(id, eta)`, if present.
    try {
      const ev = rc.logs
        .map((l: any) => {
          try {
            return this.contract.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .find((e: any) => e!.name === "ProposalQueued");
      if (!ev) return null;
      return BigInt(ev.args?.eta ?? ev.args?.[1]);
    } catch {
      return null;
    }
  }

  /** Execute the queued proposal (Timelock calls the targets).
   *
   *  Solidity:
   *    function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash)
   *      external payable returns (uint256 proposalId);
   */
  async execute(proposalId: bigint | number): Promise<TransactionReceipt> {
    const { targets, values, calldatas, description } =
      await this.getProposalDetails(proposalId);
    const dh = GenericGovernorHelper.descriptionHash(description);
    const tx = await this.contract.execute(targets, values, calldatas, dh);
    return tx.wait();
  }

  /** Cancel a pending/active proposal (if allowed by rules/timelock).
   *
   *  Solidity:
   *    function cancel(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash)
   *      external returns (uint256 proposalId);
   */
  async cancel(proposalId: bigint | number): Promise<TransactionReceipt> {
    const { targets, values, calldatas, description } =
      await this.getProposalDetails(proposalId);
    const dh = GenericGovernorHelper.descriptionHash(description);
    const tx = await this.contract.cancel(targets, values, calldatas, dh);
    return tx.wait();
  }

  /* ================================================================ */
  /* 3) Voting (cast/weights/strategy)                                 */
  /* ================================================================ */

  /** Cast a simple vote (0=Against, 1=For, 2=Abstain). */
  async castVote(
    proposalId: bigint | number,
    support: 0 | 1 | 2
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.castVote(proposalId, support);
    return tx.wait();
  }

  /** Cast a vote with a reason (stored on-chain). */
  async castVoteWithReason(
    proposalId: bigint | number,
    support: 0 | 1 | 2,
    reason: string
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.castVoteWithReason(
      proposalId,
      support,
      reason
    );
    return tx.wait();
  }

  /** Optional: cast vote with params (GovernorCountingSimple supports this overload). */
  async castVoteWithReasonAndParams(
    proposalId: bigint | number,
    support: 0 | 1 | 2,
    reason: string,
    params: BytesLike
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.castVoteWithReasonAndParams(
      proposalId,
      support,
      reason,
      params
    );
    return tx.wait();
  }

  /** Change default weight strategy (onlyGovernance). Emits `DefaultStrategySet`. */
  async updateStrategy(id4: BytesLike, newAddr: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.updateStrategy(id4, newAddr);
    return tx.wait();
  }

  /** Current default weight strategy address. */
  async defaultStrategy(): Promise<Address> {
    return (await this.contract.defaultStrategy()) as Address;
  }

  /* ================================================================ */
  /* 4) Views (proposal/time/quorum/threshold/origin)                  */
  /* ================================================================ */

  /** Read back extended proposal details stored on-chain. */
  async getProposalDetails(id: bigint | number): Promise<ProposalDetails> {
    const [
      proposer,
      rawTargets,
      rawValues,
      rawCalldatas,
      start,
      end,
      description,
    ] = await this.contract.getProposalDetails(id);

    return {
      proposer: ethers.getAddress(proposer) as Address,
      targets: (rawTargets as string[]).map((a) =>
        ethers.getAddress(a)
      ) as Address[],
      values: (rawValues as any[]).map((v) => BigInt(v)),
      calldatas: (rawCalldatas as any[]).map((d) => d as string),
      start: BigInt(start),
      end: BigInt(end),
      description,
    };
  }

  /** Tally for/against and total supply at snapshot (helper view). */
  async tally(
    id: bigint | number
  ): Promise<{ yesVotes: bigint; noVotes: bigint; supply: bigint }> {
    const [yes, no, supply] = await this.contract.tally(id);
    return { yesVotes: BigInt(yes), noVotes: BigInt(no), supply: BigInt(supply) };
    }
  
  /** Custom start timestamp for proposal id. */
  async getStartTime(id: bigint | number): Promise<bigint> {
    return BigInt(await this.contract.getStartTime(id));
  }

  /** Custom end timestamp for proposal id. */
  async getEndTime(id: bigint | number): Promise<bigint> {
    return BigInt(await this.contract.getEndTime(id));
  }

  /** Governor state (honors timestamp window via .sol override). */
  async state(id: bigint | number): Promise<number> {
    return Number(await this.contract.state(id));
  }

  /** Whether this proposal needs timelock queuing. */
  async proposalNeedsQueuing(id: bigint | number): Promise<boolean> {
    return this.contract.proposalNeedsQueuing(id) as Promise<boolean>;
  }

  /** Quorum at a given block (strategy-based). */
  async quorum(blockNumber: bigint | number): Promise<bigint> {
    return BigInt(await this.contract.quorum(blockNumber));
  }

  /** Proposal threshold from GovernorSettings (could be strategy-based upstream). */
  async proposalThreshold(): Promise<bigint> {
    return BigInt(await this.contract.proposalThreshold());
  }

  /** Origin of the proposal (Standalone or Meta). */
  async proposalOrigin(id: bigint | number): Promise<Origin> {
    return Number(await this.contract.proposalOrigin(id)) as Origin;
  }

  /* ================================================================ */
  /* 5) Config / Addresses / Meta-tx                                   */
  /* ================================================================ */

  /** Underlying IVotes token address. */
  async token(): Promise<Address> {
    return (await this.contract.token()) as Address;
  }

  /** Timelock controller address. */
  async timelock(): Promise<Address> {
    return (await this.contract.timelock()) as Address;
  }

  /** Update an ERC-2771 trusted forwarder (ADMIN_ROLE only). */
  async updateForwarder(
    forwarder: Address,
    trust: boolean
  ): Promise<TransactionReceipt> {
    const tx = await this.contract.updateForwarder(forwarder, trust);
    return tx.wait();
  }

  /** ERC-165 interface support (aggregated across parents). */
  async supportsInterface(iid: BytesLike): Promise<boolean> {
    return this.contract.supportsInterface(iid) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 6) Role helpers (AccessControl)                                   */
  /* ================================================================ */

  /** Read META_ROLE value (public constant in .sol). */
  async META_ROLE(): Promise<Bytes32> {
    return this.contract.META_ROLE() as Promise<Bytes32>;
  }

  /** Read ADMIN_ROLE value (public constant exposed by RolesCommon). */
  async ADMIN_ROLE(): Promise<Bytes32> {
    return this.contract.ADMIN_ROLE() as Promise<Bytes32>;
  }

  /** Grant a role (bytes32) to an account (DEFAULT_ADMIN_ROLE required). */
  async grantRole(role: BytesLike, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.grantRole(role, account);
    return tx.wait();
  }

  /** Revoke a role (bytes32) from an account (DEFAULT_ADMIN_ROLE required). */
  async revokeRole(role: BytesLike, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.revokeRole(role, account);
    return tx.wait();
  }

  /** Renounce a role for the connected signer. */
  async renounceRole(role: BytesLike, account: Address): Promise<TransactionReceipt> {
    const tx = await this.contract.renounceRole(role, account);
    return tx.wait();
  }

  /** Check if `account` holds `role`. */
  async hasRole(role: BytesLike, account: Address): Promise<boolean> {
    return this.contract.hasRole(role, account) as Promise<boolean>;
  }

  /* ================================================================ */
  /* 7) Utilities                                                      */
  /* ================================================================ */

  /** Compute OZ Governor descriptionHash = keccak256(utf8(description)). */
  static descriptionHash(description: string): Bytes32 {
    return ethers.keccak256(ethers.toUtf8Bytes(description)) as Bytes32;
  }

  /** On-chain pure id computation (matches Governor’s hasher). */
  async hashProposal(args: {
    targets: readonly Address[];
    values: readonly (bigint | number)[];
    calldatas: readonly BytesLike[];
    description: string;
  }): Promise<bigint> {
    const dh = GenericGovernorHelper.descriptionHash(args.description);
    const id = await this.contract.hashProposal(
      args.targets,
      args.values,
      args.calldatas,
      dh
    );
    return BigInt(id);
  }

  /* ================================================================ */
  /* 8) Event queries (optional conveniences)                          */
  /* ================================================================ */

  /** Query `ProposalCreated` events. */
  async queryProposalCreated(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.ProposalCreated);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `ProposalQueued` events. */
  async queryProposalQueued(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.ProposalQueued);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `ProposalExecuted` events. */
  async queryProposalExecuted(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.ProposalExecuted);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `VoteCast` events. */
  async queryVoteCast(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.VoteCast);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }

  /** Query `DefaultStrategySet(id,address)` events. */
  async queryDefaultStrategySet(from?: number | string, to?: number | string) {
    const ev = this.contract.getEvent(EVT.DefaultStrategySet);
    return this.contract.queryFilter(ev, from ?? 0, to ?? "latest");
  }
}

export default GenericGovernorHelper;
