/* src/types.ts --------------------------------------------------------- */
import { Interface, type InterfaceAbi } from 'ethers';

/**
 * Parameters expected by an EIP‑2612 `permit()` call.
 */
export interface PermitParams {
  /** Token holder who is granting the allowance */
  owner: string;
  /** Address that will receive the allowance */
  spender: string;
  /** Allowance amount (token’s smallest unit) */
  value: bigint;
  /** Unix timestamp (seconds) after which the permit is invalid */
  deadline: bigint;
}

/**
 * Compact ECDSA signature components produced by a wallet.
 */
export interface PermitSignature {
  v: number;
  r: string;
  s: string;
}

/**
 * Locate and return the `permit` function fragment from a contract ABI using
 * only `ethers`. Throws if the ABI doesn’t contain a suitable definition.
 *
 * ```ts
 * import { ERC20_ABI } from './abi';
 * const fragment = permitFragment(ERC20_ABI);
 * ```
 */
export function permitFragment(abi: InterfaceAbi) {
  const iface = new Interface(abi);
  const fragment = iface.getFunction('permit');
  if (!fragment) throw new Error('ABI does not contain permit()');
  return fragment; // ethers.utils.FunctionFragment
}
