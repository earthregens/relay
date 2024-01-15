export type DbSnLocation = {
  id: string;
  inscription_id: string | null;
  block_height: string;
  tx_id: string;
  tx_index: number;
  address: string | null;
};

export type DbSnScannedInscription = DbSnLocation & {
  genesis: boolean;
};

export type DbSnDeployInsert = {
  inscription_id: string;
  block_height: string;
  tx_id: string;
  address: string;
  ticker: string;
  max: string;
  decimals: string;
  limit: string | null;
  tx_count: number;
};

export type DbSnMintInsert = {
  inscription_id: string;
  sn_deploy_id: string;
  block_height: string;
  tx_id: string;
  address: string;
  amount: string;
};

export type DbSnDeploy = {
  id: string;
  inscription_id: string;
  block_height: string;
  tx_id: string;
  address: string;
  ticker: string;
  max: string;
  decimals: string;
  limit?: string;
};

export type DbSnTransferInsert = {
  inscription_id: string;
  sn_deploy_id: string;
  block_height: string;
  tx_id: string;
  from_address: string;
  to_address: string | null;
  amount: string;
};

export type DbSnTransfer = {
  id: string;
  inscription_id: string;
  sn_deploy_id: string;
  block_height: string;
  tx_id: string;
  from_address: string;
  to_address?: string;
  amount: string;
};

export type DbSnToken = {
  id: string;
  genesis_id: string;
  number: string;
  block_height: string;
  tx_id: string;
  address: string;
  ticker: string;
  max: string;
  limit?: string;
  decimals: number;
  timestamp: number;
  minted_supply: string;
  tx_count: string;
};

export type DbSnTokenWithSupply = DbSnToken & {
  minted_supply: string;
  holders: string;
};

export type DbSnHolder = {
  address: string;
  total_balance: string;
  decimals: number;
};

export type DbSnBalance = {
  ticker: string;
  decimals: number;
  avail_balance: string;
  trans_balance: string;
  total_balance: string;
};

export enum DbSnBalanceTypeId {
  mint = 0,
  transferIntent = 1,
  transferFrom = 2,
  transferTo = 3,
}

export enum DbSnEventOperation {
  deploy = 'deploy',
  mint = 'mint',
  transfer = 'transfer',
  transferSend = 'transfer_send',
}
export const SN_OPERATIONS = ['deploy', 'mint', 'transfer', 'transfer_send'];

type BaseEvent = {
  inscription_id: string;
  genesis_location_id: string;
  sn_deploy_id: string;
};

export type DbSnDeployEvent = BaseEvent & {
  operation: 'deploy';
  deploy_id: string;
  mint_id: null;
  transfer_id: null;
};

export type DbSnMintEvent = BaseEvent & {
  operation: 'mint';
  deploy_id: null;
  mint_id: string;
  transfer_id: null;
};

export type DbSnTransferEvent = BaseEvent & {
  operation: 'transfer' | 'transfer_send';
  deploy_id: null;
  mint_id: null;
  transfer_id: string;
};

export type DbSnEvent = DbSnDeployEvent | DbSnMintEvent | DbSnTransferEvent;

type BaseActivity = {
  ticker: string;
  deploy_decimals: number;
  deploy_max: string;
  deploy_limit: string | null;
  operation: DbSnEventOperation;
  output: string;
  offset: string;
  sn_deploy_id: string;
  inscription_id: string;
  block_height: string;
  block_hash: string;
  tx_id: string;
  address: string;
  timestamp: number;
};

export type DbSnDeployActivity = BaseActivity & {
  operation: DbSnEventOperation.deploy;
};

export type DbSnMintActivity = BaseActivity & {
  operation: DbSnEventOperation.mint;
  mint_amount: string;
};

export type DbSnTransferActivity = BaseActivity & {
  operation: DbSnEventOperation.transfer | DbSnEventOperation.transferSend;
  transfer_data: string;
};

export type DbSnActivity = DbSnDeployActivity | DbSnMintActivity | DbSnTransferActivity;

export const SN_DEPLOYS_COLUMNS = [
  'id',
  'inscription_id',
  'block_height',
  'tx_id',
  'address',
  'ticker',
  'max',
  'decimals',
  'limit',
  'minted_supply',
  'tx_count',
];

export const SN_TRANSFERS_COLUMNS = [
  'id',
  'inscription_id',
  'sn_deploy_id',
  'block_height',
  'tx_id',
  'from_address',
  'to_address',
  'amount',
];
