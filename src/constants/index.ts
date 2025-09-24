import {
  PrivilegeNFT,
  PrivilegeEdition,
  AgreementManager,
  DebtManager,
  BondToken,
  MarketManager,
  Whitelist,
  FlexibleToken,
  TimelockController,
  Staking,
  GenericGovernor,
  MetaGovernor,
  MultiTrustCredential,
  EmergencyPauseManager,
  Splitter,
  ReservePool,
  KpiRegistry
} from '../contracts';

export const FACTORY_ADDRESSES: Record<number, string> = {
  11155111: '0x7d4B0E58A871DBB35C7DFd131ba1eEdD3a767e67',
};

export const DEFAULT_IMPL_OWNER: Record<number,string> = {
  11155111: '0x9425E84f751970c27DC889a21C270712D131B20a'
}

export const DEFAULT_VERIFIER_ADDRESSES: Record<number, string> = {
  11155111: '0x6c06053F13f03D319eA31F92CF954112C4b0A566'
}

export const DEFAULT_INIT_FN: Record<string,string> = {
  'BondToken': BondToken.initArgs,
  'PrivilegeNFT': PrivilegeNFT.initArgs,
  'PrivilegeEdition': PrivilegeEdition.initArgs,
  'AgreementManager': AgreementManager.initArgs,
  'DebtManager': DebtManager.initArgs,
  'MarketManager': MarketManager.initArgs,
  'Whitelist': Whitelist.initArgs,
  'FlexibleToken': FlexibleToken.initArgs,
  'GenericGovernor': GenericGovernor.initArgs,
  'TimelockController': TimelockController.initArgs,
  'MetaGovernor': MetaGovernor.initArgs,
  'Staking': Staking.initArgs,
  'MultiTrustCredential': MultiTrustCredential.initArgs,
  'EmergencyPauseManager': EmergencyPauseManager.initArgs,
  'Splitter': Splitter.initArgs,
  'ReservePool': ReservePool.initArgs,
  'KpiRegistry': KpiRegistry.initArgs
}