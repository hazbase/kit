export type HazbaseWalletApiErrorBody = {
  message?: string | { message?: string; code?: string; errorCode?: string };
  error?: string;
  reason?: string;
  code?: string;
  errorCode?: string;
};

export class HazbaseWalletApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: HazbaseWalletApiErrorBody;

  constructor(message: string, status: number, code?: string, body?: HazbaseWalletApiErrorBody) {
    super(message);
    this.name = 'HazbaseWalletApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export const DEFAULT_HAZBASE_API_ENDPOINT = 'https://api.hazbase.com';

export type HazbaseWalletClientOptions = {
  apiEndpoint?: string;
  fetcher?: typeof fetch;
  headers?: Record<string, string>;
  requestId?: () => string;
};

export type WalletTokenSummary = {
  tokenId?: string;
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  standard: string;
  transferable: boolean;
  whitelistRequired: boolean;
  voucherRedeemEnabled: boolean;
  blockExplorerUrl?: string | null;
  metadata?: Record<string, unknown>;
};

export type WalletTokenBalance = {
  raw: string;
  formatted: string;
  decimals: number;
  symbol: string;
};

export type ListTokensInput = {
  chainId?: number;
  endpoint?: string;
};

export type ListTokensResult = {
  tokens: WalletTokenSummary[];
  status?: string;
};

export type GetTokenInfoInput = {
  chainId?: number;
  token: string;
  endpoint?: string;
};

export type GetTokenInfoResult = {
  token: WalletTokenSummary;
  status?: string;
};

export type GetBalanceInput = {
  chainId?: number;
  token: string;
  account: string;
  endpoint?: string;
};

export type GetBalanceResult = {
  chainId: number;
  account: string;
  token: WalletTokenSummary;
  balance: WalletTokenBalance;
  status?: string;
};

export type X402PaymentActivityDetails = {
  paymentRequestId: string;
  paymentAttemptId?: string;
  xPaymentHash?: string;
  scheme?: string;
  network?: string | null;
  resourceId?: string;
  resourceUrl?: string;
  description?: string | null;
  mimeType?: string | null;
  amountAtomic?: string;
  payTo?: string;
  payoutKind?: string;
  status?: string;
  paidAt?: string | null;
  settledAt?: string | null;
  relayMode?: string;
  submittedUserOpHash?: string | null;
  proof?: Record<string, unknown> | null;
};

export type WalletActivityItem = {
  id: string;
  kind?: string;
  direction: string;
  chainId: number;
  account: string;
  tokenAddress: string;
  from: string;
  to: string;
  counterparty: string;
  amount: WalletTokenBalance;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  transactionIndex: number;
  at?: string | null;
  status?: string;
  x402?: X402PaymentActivityDetails;
};

export type GetActivityInput = {
  chainId?: number;
  token: string;
  account: string;
  limit?: number;
  cursor?: string;
  fromBlock?: number;
  toBlock?: number;
  endpoint?: string;
};

export type GetActivityResult = {
  chainId: number;
  account: string;
  token: WalletTokenSummary;
  activities: WalletActivityItem[];
  nextCursor?: string | null;
  range?: {
    fromBlock: number;
    toBlock: number;
    latestBlock: number;
  };
  status?: string;
};

export type PrepareTransferInput = {
  chainId?: number;
  token: string;
  account: string;
  recipient: string;
  amount: string;
  metadata?: Record<string, unknown>;
  endpoint?: string;
};

export type PrepareTransferResult = {
  chainId: number;
  account: string;
  recipient: string;
  token: WalletTokenSummary;
  amount: {
    input: string;
    raw: string;
    formatted: string;
    decimals: number;
    symbol: string;
  };
  execution: {
    target: string;
    value: string;
    data: string;
    method: string;
    selector: string;
  };
  policy: {
    authorization: string;
    sessionEligible: boolean;
    sponsored: boolean;
  };
  display: {
    title: string;
    subtitle: string;
    from: string;
    to: string;
    assetSymbol: string;
    assetName: string;
  };
  metadata?: Record<string, unknown>;
  status?: string;
};

export type SubmitTransferInput = {
  emailSession: string;
  chainId?: number;
  token: string;
  account: string;
  recipient: string;
  amount: string;
  deviceBindingId: string;
  highTrustToken: string;
  accountSalt?: string;
  paymasterValiditySec?: number;
  waitForReceipt?: boolean;
  metadata?: Record<string, unknown>;
  endpoint?: string;
};

export type SubmitTransferResult = {
  chainId: number;
  token: WalletTokenSummary;
  transfer: {
    account: string;
    recipient: string;
    amount: PrepareTransferResult['amount'];
    execution: PrepareTransferResult['execution'];
  };
  relayMode?: string;
  bundlerRpcUrl?: string;
  entryPointAddress?: string;
  smartAccountAddress: string;
  nonce: string;
  initCode: string;
  localUserOpHash?: string | null;
  submittedUserOpHash?: string | null;
  transactionHash?: string | null;
  gasEstimate?: Record<string, unknown>;
  receipt?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  status?: string;
};

export type PayX402WithHazbaseWalletInput = {
  emailSession: string;
  paymentRequestId: string;
  smartAccountAddress: string;
  deviceBindingId: string;
  highTrustToken: string;
  accountSalt?: string;
  waitForReceipt?: boolean;
  expectedAmountAtomic?: string;
  expectedPayTo?: string;
  endpoint?: string;
};

export type X402HazbaseWalletPaymentResult = {
  paymentRequestId: string;
  paymentAttemptId: string;
  xPaymentHash: string;
  paid: boolean;
  verified: boolean;
  settled: boolean;
  payer: string;
  chainId: number;
  network: string;
  relayMode?: string;
  submittedUserOpHash?: string | null;
  transactionHash?: string | null;
  gasEstimate?: Record<string, unknown>;
  xPayment: string;
  receipt?: Record<string, unknown> | null;
  status?: string;
};

export type CreateWalletLinkChallengeInput = {
  origin: string;
  purpose?: string;
  endpoint?: string;
};

export type WalletLinkChallengeResult = {
  challengeId: string;
  nonce: string;
  origin: string;
  purpose: string;
  expiresAt: string;
  status?: string;
};

export type ApproveWalletLinkInput = {
  emailSession: string;
  challengeId: string;
  nonce: string;
  walletAddress: string;
  chainId: number;
  endpoint?: string;
};

export type ApproveWalletLinkResult = {
  challengeId: string;
  proof: string;
  expiresAt: string;
  status?: string;
};

export type VerifyWalletLinkInput = {
  challengeId: string;
  nonce: string;
  proof: string;
  origin: string;
  endpoint?: string;
};

export type VerifyWalletLinkResult = {
  verified: true;
  walletAddress: string;
  chainId: number;
  origin: string;
  purpose: string;
  assurance: 'authenticated_wallet_session';
  expiresAt: string;
  linkSessionToken: string;
  linkSessionExpiresAt: string;
  status?: string;
};

export type VerifyWalletLinkSessionInput = {
  linkSessionToken: string;
  origin: string;
  endpoint?: string;
};

export type VerifyWalletLinkSessionResult = {
  verified: true;
  linkSessionId: string;
  walletAddress: string;
  chainId: number;
  origin: string;
  purpose: string;
  assurance: 'authenticated_wallet_session';
  linkSessionExpiresAt: string;
  status?: string;
};

export type HazbaseWalletClient = ReturnType<typeof createHazbaseWalletClient>;

export function createHazbaseWalletClient(options: HazbaseWalletClientOptions = {}) {
  const apiEndpoint = normalizeEndpoint(options.apiEndpoint ?? DEFAULT_HAZBASE_API_ENDPOINT);
  const fetcher = options.fetcher ?? fetch;
  const defaultHeaders = options.headers ?? {};
  const createRequestId = options.requestId ?? defaultRequestId;

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    input: {
      body?: Record<string, unknown>;
      emailSession?: string;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...defaultHeaders,
    };
    let body: string | undefined;
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      headers['x-request-id'] = createRequestId();
      body = JSON.stringify(input.body ?? {});
    }
    if (input.emailSession) headers.authorization = `Bearer ${input.emailSession}`;

    const response = await fetcher(`${apiEndpoint}${path}`, {
      method,
      headers,
      ...(body ? { body } : {}),
    });
    return readJson<T>(response);
  }

  return {
    listTokens(input: ListTokensInput = {}): Promise<ListTokensResult> {
      const endpoint = input.endpoint ?? '/api/wallet/tokens';
      const query = input.chainId != null ? `?chainId=${encodeURIComponent(String(input.chainId))}` : '';
      return request<ListTokensResult>('GET', `${endpoint}${query}`);
    },

    getTokenInfo(input: GetTokenInfoInput): Promise<GetTokenInfoResult> {
      return request<GetTokenInfoResult>('POST', input.endpoint ?? '/api/wallet/token-info', {
        body: {
          token: input.token,
          ...(input.chainId != null ? { chainId: input.chainId } : {}),
        },
      });
    },

    getBalance(input: GetBalanceInput): Promise<GetBalanceResult> {
      return request<GetBalanceResult>('POST', input.endpoint ?? '/api/wallet/balance', {
        body: {
          token: input.token,
          account: input.account,
          ...(input.chainId != null ? { chainId: input.chainId } : {}),
        },
      });
    },

    getActivity(input: GetActivityInput): Promise<GetActivityResult> {
      return request<GetActivityResult>('POST', input.endpoint ?? '/api/wallet/activity', {
        body: {
          token: input.token,
          account: input.account,
          ...(input.chainId != null ? { chainId: input.chainId } : {}),
          ...(input.limit != null ? { limit: input.limit } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.fromBlock != null ? { fromBlock: input.fromBlock } : {}),
          ...(input.toBlock != null ? { toBlock: input.toBlock } : {}),
        },
      });
    },

    prepareTransfer(input: PrepareTransferInput): Promise<PrepareTransferResult> {
      return request<PrepareTransferResult>('POST', input.endpoint ?? '/api/wallet/transfer/prepare', {
        body: {
          token: input.token,
          account: input.account,
          recipient: input.recipient,
          amount: input.amount,
          ...(input.chainId != null ? { chainId: input.chainId } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      });
    },

    submitTransfer(input: SubmitTransferInput): Promise<SubmitTransferResult> {
      return request<SubmitTransferResult>('POST', input.endpoint ?? '/api/wallet/transfer/submit', {
        emailSession: input.emailSession,
        body: {
          token: input.token,
          account: input.account,
          recipient: input.recipient,
          amount: input.amount,
          deviceBindingId: input.deviceBindingId,
          highTrustToken: input.highTrustToken,
          ...(input.chainId != null ? { chainId: input.chainId } : {}),
          ...(input.accountSalt ? { accountSalt: input.accountSalt } : {}),
          ...(input.paymasterValiditySec != null ? { paymasterValiditySec: input.paymasterValiditySec } : {}),
          ...(input.waitForReceipt != null ? { waitForReceipt: input.waitForReceipt } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      });
    },

    payX402WithHazbaseWallet(input: PayX402WithHazbaseWalletInput): Promise<X402HazbaseWalletPaymentResult> {
      return request<X402HazbaseWalletPaymentResult>('POST', input.endpoint ?? '/api/payments/x402/hazbase-wallet/pay', {
        emailSession: input.emailSession,
        body: {
          paymentRequestId: input.paymentRequestId,
          smartAccountAddress: input.smartAccountAddress,
          deviceBindingId: input.deviceBindingId,
          highTrustToken: input.highTrustToken,
          ...(input.accountSalt ? { accountSalt: input.accountSalt } : {}),
          ...(input.waitForReceipt != null ? { waitForReceipt: input.waitForReceipt } : {}),
          ...(input.expectedAmountAtomic ? { expectedAmountAtomic: input.expectedAmountAtomic } : {}),
          ...(input.expectedPayTo ? { expectedPayTo: input.expectedPayTo } : {}),
        },
      });
    },

    createWalletLinkChallenge(input: CreateWalletLinkChallengeInput): Promise<WalletLinkChallengeResult> {
      return request<WalletLinkChallengeResult>('POST', input.endpoint ?? '/api/wallet/link/challenge', {
        body: {
          origin: input.origin,
          purpose: input.purpose ?? 'wallet_connection',
        },
      });
    },

    approveWalletLink(input: ApproveWalletLinkInput): Promise<ApproveWalletLinkResult> {
      return request<ApproveWalletLinkResult>('POST', input.endpoint ?? '/api/wallet/link/approve', {
        emailSession: input.emailSession,
        body: {
          challengeId: input.challengeId,
          nonce: input.nonce,
          walletAddress: input.walletAddress,
          chainId: input.chainId,
        },
      });
    },

    verifyWalletLink(input: VerifyWalletLinkInput): Promise<VerifyWalletLinkResult> {
      return request<VerifyWalletLinkResult>('POST', input.endpoint ?? '/api/wallet/link/verify', {
        body: {
          challengeId: input.challengeId,
          nonce: input.nonce,
          proof: input.proof,
          origin: input.origin,
        },
      });
    },

    verifyWalletLinkSession(input: VerifyWalletLinkSessionInput): Promise<VerifyWalletLinkSessionResult> {
      return request<VerifyWalletLinkSessionResult>('POST', input.endpoint ?? '/api/wallet/link/session/verify', {
        body: {
          linkSessionToken: input.linkSessionToken,
          origin: input.origin,
        },
      });
    },
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const json = await response.json().catch(() => undefined);
  if (!response.ok) {
    const body = (json ?? {}) as HazbaseWalletApiErrorBody;
    const nested = typeof body.message === 'object' ? body.message : undefined;
    const message = typeof body.message === 'string'
      ? body.message
      : nested?.message ?? body.error ?? body.reason ?? `${response.status} ${response.statusText}`;
    throw new HazbaseWalletApiError(message, response.status, body.code ?? body.errorCode ?? nested?.code ?? nested?.errorCode, body);
  }
  return (json?.data ?? json) as T;
}

function normalizeEndpoint(value: string): string {
  return value.replace(/\/+$/u, '');
}

let requestCounter = 0;
function defaultRequestId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return `req_${c.randomUUID()}`;
  if (c?.getRandomValues) {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return `req_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  return `req_${Date.now().toString(36)}_${(requestCounter++).toString(36)}`;
}
