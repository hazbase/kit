import { ethers } from 'ethers';
import { forwardCall } from '@hazbase/relayer';

interface BuilderInit {
  address:  string;
  abi:      ethers.InterfaceAbi;
  chainId:  number;
  signer:   ethers.JsonRpcSigner;
}

interface RelayerCfg {
  accessToken: string;
}

export class ContractBuilder {
  private readonly address: string;
  private readonly abi:     ethers.InterfaceAbi;
  private readonly chainId: number;
  private readonly signer:  ethers.JsonRpcSigner;
  private relayer?: RelayerCfg;

  private _chainIdOk?: Promise<void>;

  private constructor(init: BuilderInit) {
    this.address = init.address;
    this.abi     = init.abi;
    this.chainId = init.chainId;
    this.signer  = init.signer;
  }

  /**
   * Verify the signer's live chain matches init.chainId before signing. The meta-tx
   * (relayer) path uses chainId for the EIP-712 forwarder domain, and a mismatch
   * would produce a signature valid on a different chain than the caller intended.
   * Memoized so it runs at most once per builder.
   */
  private assertChainId(): Promise<void> {
    if (!this._chainIdOk) {
      this._chainIdOk = (async () => {
        const net = await this.signer.provider.getNetwork();
        const actual = Number(net.chainId);
        if (actual !== this.chainId) {
          throw new Error(
            `ContractBuilder chainId mismatch: signer is on ${actual} but init.chainId=${this.chainId}`,
          );
        }
      })();
    }
    return this._chainIdOk;
  }

  static create(init: BuilderInit): ContractBuilder {
    return new ContractBuilder(init);
  }

  withRelayer(cfg: RelayerCfg): ContractBuilder {
    this.relayer = cfg;
    return this;
  }

  build(): any {
    const onchain = new ethers.Contract(
      this.address,
      this.abi,
      this.signer
    );

    const handler: ProxyHandler<any> = {
      get: (_, prop, receiver) => {
        if (prop === 'call') {
          return async (method: string, args: unknown[]) =>
            this.invoke(method, args, onchain);
        }

        if (
          typeof prop === 'string' &&
          typeof (onchain as any)[prop] === 'function'
        ) {
          return async (...args: any[]) =>
            this.invoke(prop, args, onchain);
        }

        return Reflect.get(onchain, prop, receiver);
      }
    };

    return new Proxy({}, handler);
  }

  /* ------------------------------------------------------------------ */

  private async invoke(
    method: string,
    args: unknown[],
    onchain: ethers.Contract
  ): Promise<any> {
    const frag = onchain.interface.getFunction(method);
    const isRead = frag?.stateMutability === 'view' || frag?.stateMutability === 'pure';

    /* ---------- read‑only: straight eth_call ------------------------ */
    if (isRead) {
      return onchain[method](...args);
    }

    /* ---------- state‑changing paths -------------------------------- */
    await this.assertChainId();

    if (this.relayer) {
      /* gasless via relayer */
      return forwardCall({
        signer: this.signer,
        chainId: this.chainId,
        accessToken: this.relayer.accessToken,
        contractAddress: this.address,
        abi: this.abi,
        method,
        args
      });
    }

    /* direct on‑chain: wait for inclusion and surface reverts ---------- */
    const tx = await onchain[method](...args);
    const receipt = await tx.wait(1);
    if (!receipt) throw new Error(`transaction ${tx.hash} was not mined`);
    if (receipt.status === 0) throw new Error(`transaction ${tx.hash} reverted`);
    return { txHash: tx.hash, logs: receipt.logs ?? [] };
  }
}
