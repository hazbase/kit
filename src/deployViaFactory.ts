import {
  FACTORY_ADDRESSES,
  DEFAULT_IMPL_OWNER,
  DEFAULT_INIT_FN
} from './constants';
import { ContractFactory }   from './contracts';
import { ethers }            from 'ethers';
import type { InterfaceAbi, Log } from 'ethers';

export interface DeployViaFactoryOptions {
  contractType : string;              // e.g. 'BondToken'
  implABI      : InterfaceAbi;
  initArgs     : readonly unknown[];
  signer       : ethers.Signer;

  /* optional overrides */
  factory?   : string;
  implOwner? : string;
  initFn?    : string;
  version?   : number;
}

export interface FactoryDeployResult {
  address : string;                   // proxy
  txHash  : string;
  receipt : ethers.TransactionReceipt;
}

export async function deployViaFactory(
  opt: DeployViaFactoryOptions
): Promise<FactoryDeployResult> {

  const {
    contractType, implABI, initArgs, signer,
    version, factory: factoryOverride,
    implOwner: ownerOverride, initFn: initFnOverride
  } = opt;

  /* ---------- network / default look-ups ------------------ */
  const provider = signer.provider;
  if (!provider) throw new Error('Signer must have a provider');
  const chainId  = Number((await provider.getNetwork()).chainId);
  const cTypeHash = ethers.id(contractType);

  /* factory / owner / initFn fallback tables */
  const factoryAddr =
    factoryOverride ??
    FACTORY_ADDRESSES[chainId] ??
    fail(`No factory mapping for chain ${chainId}`);

  const implOwner =
    ownerOverride ??
    DEFAULT_IMPL_OWNER[chainId] ??
    fail(`No implOwner default for chain ${chainId}`);

  const initFn =
    initFnOverride ??
    DEFAULT_INIT_FN[contractType] ??
    fail(`No default initFn for contractType "${contractType}"`);

  /* ---------- encode initializer data --------------------- */
  const iface    = new ethers.Interface(implABI);
  const initData = iface.encodeFunctionData(initFn, initArgs);

  /* ---------- call factory -------------------------------- */
  const factoryIF = new ethers.Interface(ContractFactory.abi);
  const factory   = new ethers.Contract(factoryAddr, ContractFactory.abi, signer);

  const tx = version == null
    ? await factory.deployContract(implOwner, cTypeHash, initData)
    : await factory.deployContractByVersion(implOwner, cTypeHash, version, initData);

  const receipt = await tx.wait();

  /* ---------- pull ContractDeployed event ----------------- */
  const topic = factoryIF.getEvent('ContractDeployed')?.topicHash;
  
  const log   = receipt.logs.find(
    (l: Log) => l.address.toLowerCase() === factoryAddr.toLowerCase() && l.topics[0] === topic
  ) ?? fail('ContractDeployed event not found');

  const parsed = factoryIF.parseLog(log)!;
  const proxy  = ethers.getAddress(parsed.args[2]);

  return { address: proxy, txHash: receipt.hash, receipt };
}

/* ---------- helper --------------------------------------- */
function fail(msg: string): never { throw new Error(msg); }
