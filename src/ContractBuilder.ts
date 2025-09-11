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

  private constructor(init: BuilderInit) {
    this.address = init.address;
    this.abi     = init.abi;
    this.chainId = init.chainId;
    this.signer  = init.signer;
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
    let txHash: string;

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
    } else {
      /* direct on‑chain */
      const tx = await onchain[method](...args);
      txHash = tx.hash;
    }

    /* wait for receipt & return standardized object ------------------ */
    const receipt = await this.signer.provider.waitForTransaction(txHash);
    return { txHash, logs: receipt?.logs ?? [] };
  }
}
