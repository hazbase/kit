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
  1:        '0x8347c687dF648634541744f26258Ec7aE2d7B0c8',
  11155111: '0x7d4B0E58A871DBB35C7DFd131ba1eEdD3a767e67',
  137:      '0x10ffF6E5b1e76D0092d891F88EBFE1D47608a2fF',
  80002:    '0x8C0cA4B09F86604944996a0ec3D198129AfaF95E',
  592:      '0x22A11a26685E8E0327E53Db439E8FEf6c8B0bDab',
  1868:     '',
  1946:     '0xf353e74fea27a4c6a835f24dE772F661E31b3823',
  480:      '',
  4801:     '0x6f2C82286713b2a5ff1aF213b48313393674d7EF',
  336:      '',
  42220:    '0x3A050F48A75cf55Bd5E40112a199ACEB081011A5',
  44787:    '',
  56:       '',
  97:       '',
  43114:    '0xf353e74fea27a4c6a835f24dE772F661E31b3823',
  43113:    '0xf353e74fea27a4c6a835f24dE772F661E31b3823',
  1101:     '',
  2442:     '',
  5042002:  '0xf353e74fea27a4c6a835f24dE772F661E31b3823',
};

export const DEFAULT_IMPL_OWNER: Record<number,string> = {
  1:        '0x9425E84f751970c27DC889a21C270712D131B20a',
  11155111: '0x9425E84f751970c27DC889a21C270712D131B20a',
  137:      '0x9425E84f751970c27DC889a21C270712D131B20a',
  80002:    '0x9425E84f751970c27DC889a21C270712D131B20a',
  592:      '0x9425E84f751970c27DC889a21C270712D131B20a',
  1868:     '',
  1946:     '0x9425E84f751970c27DC889a21C270712D131B20a',
  480:      '',
  4801:     '0x9425E84f751970c27DC889a21C270712D131B20a',
  336:      '',
  42220:    '0x9425E84f751970c27DC889a21C270712D131B20a',
  44787:    '',
  56:       '',
  97:       '',
  43114:    '0x9425E84f751970c27DC889a21C270712D131B20a',
  43113:    '0x9425E84f751970c27DC889a21C270712D131B20a',
  1101:     '',
  2442:     '',
  5042002:  '0x9425E84f751970c27DC889a21C270712D131B20a',
}

export const DEFAULT_VERIFIER_ADDRESSES: Record<number, Record<string, string>> = {
  11155111: {
    default: '0x6c06053F13f03D319eA31F92CF954112C4b0A566',
    group:   '0xf3B182d6F93B7bA89A978193B3387e5F7b82A2F4'
  }
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