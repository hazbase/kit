export type X402CompletionMode = 'fragment';

export type X402AssetPolicy = {
  asset?: string;
  address?: string;
  assetKey?: string;
  tokenId?: string;
  decimals?: number;
};

export type X402RequirementSelectionOptions = {
  scheme?: string;
  networks?: string[];
  assets?: X402AssetPolicy[];
  defaultDecimals?: number;
  requirePayTo?: boolean;
};

export type HazbaseX402Requirement = {
  scheme: string;
  network: string;
  paymentRequestId: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  asset: string;
  assetKey?: string;
  amountAtomic: string;
  amountFormatted: string;
  decimals: number;
  maxTimeoutSeconds?: number;
  raw: Record<string, unknown>;
};

export type HazbaseX402Request = {
  paymentRequestId: string;
  sourceUrl: string;
  pageTitle?: string;
  completionMode?: X402CompletionMode;
  completionParam?: string;
  bridgeRequestId?: string;
  detectedAt: string;
  requirement: HazbaseX402Requirement;
};

export type SummarizeX402RequestContext = {
  sourceUrl: string;
  pageTitle?: string;
  detectedAt?: string;
};

export type ReadX402RequestOptions = X402RequirementSelectionOptions & {
  handoffStoragePrefix?: string;
};

export type ResolveX402RequestOptions = ReadX402RequestOptions & {
  fetcher?: typeof fetch;
};

export function isX402RequestExpired(
  request: Pick<HazbaseX402Request, 'detectedAt' | 'requirement'>,
  nowMs: number,
  options: { minTtlSeconds?: number; maxTtlSeconds?: number } = {},
): boolean {
  const detected = Date.parse(request.detectedAt);
  if (!Number.isFinite(detected)) return false;
  const declared = Number(request.requirement.maxTimeoutSeconds);
  const minTtlSeconds = options.minTtlSeconds ?? 900;
  const maxTtlSeconds = options.maxTtlSeconds ?? 3600;
  const ttlSeconds = Math.min(Math.max(Number.isFinite(declared) ? declared : 0, minTtlSeconds), maxTtlSeconds);
  return nowMs - detected > ttlSeconds * 1000;
}

export function parseX402ResponseBody(input: string): Record<string, unknown> | null {
  const direct = parseJsonRecord(input);
  if (direct) return direct;
  const match = input.match(/<script[^>]+type=["']application\/x-x402\+json["'][^>]*>([\s\S]*?)<\/script>/iu);
  return match ? parseJsonRecord(unescapeScriptJson(match[1] ?? '')) : null;
}

export function summarizeX402Request(
  x402: Record<string, unknown>,
  context: SummarizeX402RequestContext,
  options: X402RequirementSelectionOptions = {},
): HazbaseX402Request | null {
  const payload = unwrapX402Payload(x402);
  const selected = selectX402Requirement(payload, options);
  if (!selected) return null;
  const paymentRequestId = readPaymentRequestId(payload, selected);
  if (!paymentRequestId) return null;
  return {
    paymentRequestId,
    sourceUrl: context.sourceUrl,
    ...(context.pageTitle ? { pageTitle: context.pageTitle } : {}),
    detectedAt: context.detectedAt ?? new Date().toISOString(),
    requirement: {
      ...selected,
      paymentRequestId,
    },
  };
}

export function readX402RequestFromUrl(
  input = globalThis.location?.href ?? '',
  options: ReadX402RequestOptions = {},
): HazbaseX402Request | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const encoded = url.searchParams.get('x402') ?? url.searchParams.get('x402Body');
  if (!encoded) {
    const paymentRequestId = safePaymentRequestId(url.searchParams.get('pay'));
    return paymentRequestId ? readX402RequestFromHandoff(paymentRequestId, options) : null;
  }

  const decoded = decodeX402Param(encoded);
  if (!decoded) return null;
  const parsed = parseJsonRecord(decoded);
  if (!parsed) return null;

  const sourceUrl = url.searchParams.get('sourceUrl') || url.searchParams.get('resourceUrl') || String(parsed.resource ?? url.href);
  const pageTitle = url.searchParams.get('title') || undefined;
  const request = summarizeX402Request(parsed, { sourceUrl, pageTitle }, options);
  if (!request) return null;

  const completionMode = url.searchParams.get('x402Completion');
  const completionParam = safeCompletionParam(url.searchParams.get('x402CompletionParam'));
  return {
    ...request,
    ...(completionMode === 'fragment' || completionMode === 'url-fragment' ? { completionMode: 'fragment' as const } : {}),
    ...(completionParam ? { completionParam } : {}),
  };
}

export async function resolveX402RequestFromUrl(
  input = globalThis.location?.href ?? '',
  options: ResolveX402RequestOptions = {},
): Promise<HazbaseX402Request | null> {
  const direct = readX402RequestFromUrl(input, options);
  if (direct) return direct;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const paymentRequestId = safePaymentRequestId(url.searchParams.get('pay'));
  if (!paymentRequestId) return null;
  const resolver = safeResolverUrl(url.searchParams.get('x402Resolver') || url.searchParams.get('resolver'));
  const sourceUrl = safeResolverUrl(url.searchParams.get('sourceUrl') || url.searchParams.get('resourceUrl'));
  const candidates = [resolver, sourceUrl].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const request = await fetchX402Request(candidate, paymentRequestId, options);
      if (request) return request;
    } catch {
      continue;
    }
  }
  return null;
}

export function selectX402Requirement(
  x402: Record<string, unknown>,
  options: X402RequirementSelectionOptions = {},
): Omit<HazbaseX402Requirement, 'paymentRequestId'> | null {
  const accepts = Array.isArray(x402.accepts)
    ? x402.accepts
    : isRecord(x402.x402) && Array.isArray(x402.x402.accepts)
      ? x402.x402.accepts
      : [];
  const expectedScheme = options.scheme ?? 'exact';
  const networks = (options.networks ?? []).map((value) => value.toLowerCase());

  for (const item of accepts) {
    if (!isRecord(item)) continue;
    if (String(item.scheme ?? '') !== expectedScheme) continue;
    const network = String(item.network ?? '').toLowerCase();
    if (networks.length && !networks.includes(network)) continue;

    const extra = isRecord(item.extra) ? item.extra : {};
    const assetKey = optionalString(extra.asset) ?? optionalString(extra.assetKey) ?? optionalString(item.assetKey);
    const assetAddress = optionalString(item.asset) ?? optionalString(extra.assetId) ?? optionalString(extra.assetAddress) ?? '';
    const matchedAsset = matchAssetPolicy(assetAddress, assetKey, options.assets ?? []);
    if ((options.assets?.length ?? 0) > 0 && !matchedAsset) continue;

    const amountAtomic = String(item.maxAmountRequired ?? item.amountAtomic ?? item.amount ?? '');
    if (!/^\d+$/u.test(amountAtomic)) continue;
    const payTo = String(item.payTo ?? '');
    if ((options.requirePayTo ?? true) && !/^0x[a-fA-F0-9]{40}$/u.test(payTo)) continue;

    const decimals = Number(extra.decimals ?? matchedAsset?.decimals ?? options.defaultDecimals ?? 18);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    const maxTimeoutSeconds = Number(item.maxTimeoutSeconds);
    return {
      scheme: expectedScheme,
      network,
      resource: String(item.resource ?? ''),
      description: optionalString(item.description),
      mimeType: optionalString(item.mimeType),
      payTo,
      asset: assetAddress,
      ...(assetKey ? { assetKey } : {}),
      amountAtomic,
      amountFormatted: atomicToDecimal(amountAtomic, decimals),
      decimals,
      ...(Number.isFinite(maxTimeoutSeconds) ? { maxTimeoutSeconds } : {}),
      raw: item,
    };
  }
  return null;
}

export function encodeX402ForUrl(x402: Record<string, unknown>): string {
  return base64UrlEncode(JSON.stringify(x402));
}

export function decodeX402Param(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith('{')) return decodeURIComponent(trimmed);
    const normalized = decodeURIComponent(trimmed).replace(/-/gu, '+').replace(/_/gu, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return null;
    }
  }
}

export function parseJsonRecord(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input.trim());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function safeCompletionParam(value: string | null): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : null;
}

export function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

async function fetchX402Request(
  input: string,
  paymentRequestId: string,
  options: ResolveX402RequestOptions,
): Promise<HazbaseX402Request | null> {
  const url = new URL(input);
  if (!url.searchParams.has('format')) url.searchParams.set('format', 'json');
  if (!url.searchParams.has('paymentRequestId')) url.searchParams.set('paymentRequestId', paymentRequestId);
  const response = await (options.fetcher ?? fetch)(url.toString(), {
    credentials: 'include',
    headers: {
      accept: 'application/json, application/x-x402+json;q=0.9, text/html;q=0.8, */*;q=0.1',
    },
  });
  if (!response.ok) return null;
  const body = await response.text();
  const parsed = parseX402ResponseBody(body);
  if (!parsed) return null;
  const request = summarizeX402Request(parsed, { sourceUrl: input }, options);
  return request?.paymentRequestId === paymentRequestId ? request : null;
}

function readX402RequestFromHandoff(
  paymentRequestId: string,
  options: ReadX402RequestOptions,
): HazbaseX402Request | null {
  const key = `${options.handoffStoragePrefix ?? 'hazbase.x402.handoff.v1'}:${paymentRequestId}`;
  for (const storage of handoffStorages()) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.x402)) continue;
      const expiresAt = optionalString(parsed.expiresAt);
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
        storage.removeItem(key);
        continue;
      }
      const sourceUrl = optionalString(parsed.sourceUrl) ?? globalThis.location?.origin ?? '';
      const pageTitle = optionalString(parsed.pageTitle);
      const request = summarizeX402Request(parsed.x402, { sourceUrl, pageTitle }, options);
      if (!request || request.paymentRequestId !== paymentRequestId) continue;
      const completionMode = parsed.completionMode === 'fragment' ? 'fragment' : undefined;
      const completionParam = safeCompletionParam(optionalString(parsed.completionParam) ?? null);
      return {
        ...request,
        ...(completionMode ? { completionMode } : {}),
        ...(completionParam ? { completionParam } : {}),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function handoffStorages(): Storage[] {
  const storages: Storage[] = [];
  try {
    if (globalThis.sessionStorage) storages.push(globalThis.sessionStorage);
  } catch {}
  try {
    if (globalThis.localStorage) storages.push(globalThis.localStorage);
  } catch {}
  return storages;
}

function safePaymentRequestId(value: string | null): string | null {
  if (!value) return null;
  return /^payreq_[A-Za-z0-9_-]{16,160}$/u.test(value) ? value : null;
}

function safeResolverUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, globalThis.location?.origin);
    if (url.protocol !== 'https:' && url.origin !== globalThis.location?.origin) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function matchAssetPolicy(assetAddress: string, assetKey: string | undefined, policies: X402AssetPolicy[]): X402AssetPolicy | null {
  if (!policies.length) return null;
  return policies.find((policy) => {
    const expectedKey = policy.assetKey ?? policy.tokenId;
    const expectedAddress = policy.asset ?? policy.address;
    const keyMatches = expectedKey ? assetKey?.toLowerCase() === expectedKey.toLowerCase() : true;
    const addressMatches = expectedAddress ? sameAddress(assetAddress, expectedAddress) : true;
    return keyMatches && addressMatches;
  }) ?? null;
}

function unwrapX402Payload(input: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(input.data) && isRecord(input.data.x402)) return input.data.x402;
  return input;
}

function readPaymentRequestId(
  x402: Record<string, unknown>,
  requirement: Omit<HazbaseX402Requirement, 'paymentRequestId'>,
): string {
  const topLevel = optionalString(x402.paymentRequestId);
  const hazbase = isRecord(x402.hazbase) ? optionalString(x402.hazbase.paymentRequestId) : undefined;
  const nested = isRecord(x402.x402) ? readPaymentRequestId(x402.x402, requirement) : undefined;
  const accepts = Array.isArray(x402.accepts) ? x402.accepts : [];
  const matched = accepts.find((item) => isRecord(item) && String(item.resource ?? '') === requirement.resource);
  const requirementId = isRecord(matched) ? optionalString(matched.paymentRequestId) : undefined;
  const extra = isRecord(matched) && isRecord(matched.extra) ? optionalString(matched.extra.paymentRequestId) : undefined;
  return topLevel ?? hazbase ?? nested ?? requirementId ?? extra ?? '';
}

function atomicToDecimal(value: string, decimals: number): string {
  const units = BigInt(value);
  if (decimals <= 0) return units.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = units % scale;
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/u, '');
  return fractionText ? `${whole.toString()}.${fractionText}` : `${whole.toString()}.0`;
}

function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unescapeScriptJson(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
