import {
  base64UrlEncode,
  decodeX402Param,
  parseJsonRecord,
  safeCompletionParam,
} from './x402';

export const HAZBASE_X402_BRIDGE_VERSION = 1;
export const HAZBASE_X402_BRIDGE_REQUEST = 'hazbase:x402:request';
export const HAZBASE_X402_BRIDGE_DETECTED = 'hazbase:x402:detected';
export const HAZBASE_X402_BRIDGE_PAYMENT = 'hazbase:x402:payment';
export const HAZBASE_X402_BRIDGE_ERROR = 'hazbase:x402:error';
export const HAZBASE_WALLET_ADDRESS_REQUEST = 'hazbase:wallet:address-request';
export const HAZBASE_WALLET_ADDRESS_RESPONSE = 'hazbase:wallet:address-response';

export type RequestWalletAddressOptions = {
  id?: string;
  version?: number;
  purpose?: string;
  targetWindow?: Window;
  origin?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
  signal?: AbortSignal;
};

export type RequestWalletAddressResult =
  | { ok: true; address: string; id: string; message: Record<string, unknown> }
  | { ok: false; id: string; reason?: string; timedOut?: boolean; message?: Record<string, unknown> };

export type ConsumeWalletAddressOptions = {
  input?: string;
  paramNames?: string[];
  replaceState?: boolean;
};

export type WalletAddressPwaUrlOptions = {
  returnUrl?: string;
  returnParam?: string;
};

export type CreateX402WalletUrlOptions = {
  sourceUrl: string;
  title?: string;
  completionMode?: 'fragment';
  completionParam?: string;
};

export type SaveX402HandoffOptions = {
  storagePrefix?: string;
  ttlMs?: number;
  sourceUrl: string;
  pageTitle?: string;
  completionMode?: 'fragment';
  completionParam?: string;
  storage?: Storage;
};

export type PublishX402RequestOptions = SaveX402HandoffOptions & {
  scriptId?: string;
  removeUrlParams?: string[];
};

export type PostX402BridgeRequestOptions = {
  id?: string;
  x402: Record<string, unknown>;
  sourceUrl: string;
  title?: string;
  completionMode?: 'fragment';
  completionParam?: string;
  origin?: string;
  targetWindow?: Window;
};

export type HazbaseX402ContentEnvelope = {
  x402: Record<string, unknown>;
  sourceUrl: string;
  completionMode?: 'fragment';
  completionParam?: string;
  bridgeRequestId?: string;
};

export type HazbaseRuntimeLike = {
  id?: string;
  lastError?: { message?: string };
  sendMessage?: (message: unknown, callback?: (response: unknown) => void) => void;
  onMessage?: {
    addListener?: (listener: (message: unknown) => void) => void;
    removeListener?: (listener: (message: unknown) => void) => void;
  };
};

export type InstallHazbaseWalletContentBridgeOptions = {
  runtime?: HazbaseRuntimeLike;
  stateKey?: string;
  walletLinkSelector?: string;
  walletName?: string;
  openX402MessageType: string;
  receiveAddressMessageType: string;
  runtimePaymentMessageType: string;
  runtimeCancelledMessageType: string;
  legacyAddressRequestType?: string;
  legacyAddressResponseType?: string;
  unavailableMessage?: string;
  walletOpenFailedMessage?: string;
  paymentCancelledMessage?: string;
  capabilities?: Record<string, unknown>;
};

export function installHazbaseWalletContentBridge(
  options: InstallHazbaseWalletContentBridgeOptions,
): () => void {
  const runtime = options.runtime ?? defaultRuntime();
  const stateKey = options.stateKey ?? '__hazbaseWalletContentBridge';
  const state = globalThis as typeof globalThis & { [key: string]: { controller?: AbortController } | undefined };
  state[stateKey]?.controller?.abort();
  const controller = new AbortController();
  state[stateKey] = { controller };
  const requestWalletOpen = createWalletOpenRequester(runtime, options);

  bindWalletLink(controller.signal, requestWalletOpen, options);
  watchWalletLinkReadiness(controller.signal, options);
  bindX402Bridge(controller.signal, requestWalletOpen, options);
  bindReceiveAddressBridge(controller.signal, runtime, options);
  bindRuntimeBridge(controller.signal, runtime, options);

  return () => {
    controller.abort();
    if (state[stateKey]?.controller === controller) delete state[stateKey];
  };
}

function bindWalletLink(
  signal: AbortSignal,
  requestWalletOpen: (envelope: HazbaseX402ContentEnvelope) => Promise<unknown>,
  options: InstallHazbaseWalletContentBridgeOptions,
): void {
  const link = document.querySelector<HTMLAnchorElement>(options.walletLinkSelector ?? '#wallet-link');
  if (!link) return;
  if (link.dataset.hazbaseWalletExtensionBound === 'true') return;
  link.dataset.hazbaseWalletExtensionBound = 'true';
  markWalletLinkReadiness(options);
  link.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const envelope = readX402Envelope();
    if (!envelope) return;
    void requestWalletOpen(envelope);
  }, { capture: true, signal });
  link.addEventListener('click', (event) => {
    const envelope = readX402Envelope();
    if (!envelope) return;
    event.preventDefault();
    event.stopPropagation();
    const fallbackUrl = link.href;
    void requestWalletOpen(envelope).then((response) => {
      if (!isRecord(response) || response.ok !== true) {
        location.href = fallbackUrl;
      }
    }).catch(() => {
      location.href = fallbackUrl;
    });
  }, { capture: true, signal });
}

function watchWalletLinkReadiness(
  signal: AbortSignal,
  options: InstallHazbaseWalletContentBridgeOptions,
): void {
  markWalletLinkReadiness(options);
  const observer = new MutationObserver(() => {
    bindWalletLink(signal, createWalletOpenRequester(options.runtime ?? defaultRuntime(), options), options);
    markWalletLinkReadiness(options);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
}

function markWalletLinkReadiness(options: InstallHazbaseWalletContentBridgeOptions): void {
  const link = document.querySelector<HTMLAnchorElement>(options.walletLinkSelector ?? '#wallet-link');
  if (!link) return;
  if (readX402Envelope()) {
    link.dataset.hazbaseWalletExtensionReady = 'true';
  } else {
    delete link.dataset.hazbaseWalletExtensionReady;
  }
}

function createWalletOpenRequester(
  runtime: HazbaseRuntimeLike | undefined,
  options: InstallHazbaseWalletContentBridgeOptions,
): (envelope: HazbaseX402ContentEnvelope) => Promise<unknown> {
  let directWalletOpenPromise: Promise<unknown> | null = null;
  return (envelope) => {
    if (directWalletOpenPromise) return directWalletOpenPromise;
    directWalletOpenPromise = sendWalletOpenRequest(runtime, options, envelope)
      .finally(() => {
        setTimeout(() => {
          directWalletOpenPromise = null;
        }, 500);
      });
    return directWalletOpenPromise;
  };
}

function sendWalletOpenRequest(
  runtime: HazbaseRuntimeLike | undefined,
  options: InstallHazbaseWalletContentBridgeOptions,
  envelope: HazbaseX402ContentEnvelope,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    runtime?.sendMessage?.({
      type: options.openX402MessageType,
      x402: envelope.x402,
      url: envelope.sourceUrl,
      title: document.title,
      ...(envelope.completionMode ? { completionMode: envelope.completionMode } : {}),
      ...(envelope.completionParam ? { completionParam: envelope.completionParam } : {}),
      ...(envelope.bridgeRequestId ? { bridgeRequestId: envelope.bridgeRequestId } : {}),
    }, (response: unknown) => {
      const error = runtime?.lastError;
      if (error) {
        reject(new Error(error.message || options.unavailableMessage || 'Wallet extension is unavailable.'));
        return;
      }
      resolve(response);
    });
  });
}

export function readX402EnvelopeFromPage(): HazbaseX402ContentEnvelope | null {
  return readX402Envelope();
}

export function createHazbaseRequestId(prefix = 'hazbase'): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/gu, '') || 'hazbase';
  const cryptoLike = globalThis.crypto;
  return cryptoLike?.randomUUID
    ? cryptoLike.randomUUID()
    : `${safePrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function normalizeEvmAddress(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/u.test(normalized) ? normalized : '';
}

export function shortenAddress(value: unknown, options: { head?: number; tail?: number; fallback?: string } = {}): string {
  const text = String(value ?? '');
  if (!text) return options.fallback ?? '';
  const head = options.head ?? 6;
  const tail = options.tail ?? 4;
  return text.length > head + tail + 1 ? `${text.slice(0, head)}...${text.slice(-tail)}` : text;
}

export function consumeWalletAddressFromFragment(options: ConsumeWalletAddressOptions = {}): string {
  const paramNames = options.paramNames ?? ['walletAddress', 'hazbaseWalletAddress'];
  const url = new URL(options.input ?? globalThis.location?.href ?? '');
  const params = new URLSearchParams(url.hash.replace(/^#/u, ''));
  let address = '';
  let changed = false;
  for (const name of paramNames) {
    address ||= normalizeEvmAddress(params.get(name));
    if (params.has(name)) {
      params.delete(name);
      changed = true;
    }
  }
  if (changed && options.replaceState !== false && globalThis.history && globalThis.location) {
    url.hash = params.toString();
    globalThis.history.replaceState(null, '', url.toString());
  }
  return address;
}

export function createWalletAddressReturnUrl(input = globalThis.location?.href ?? ''): string {
  const url = new URL(input);
  url.hash = '';
  return url.toString();
}

export function createWalletAddressPwaUrl(walletUrl: string, options: WalletAddressPwaUrlOptions = {}): string {
  const url = new URL(walletUrl);
  url.searchParams.set(options.returnParam ?? 'walletAddressReturnUrl', options.returnUrl ?? createWalletAddressReturnUrl());
  return url.toString();
}

export function requestWalletAddress(options: RequestWalletAddressOptions = {}): Promise<RequestWalletAddressResult> {
  const target = options.targetWindow ?? globalThis.window;
  const origin = options.origin ?? globalThis.location?.origin ?? '*';
  const id = options.id ?? createHazbaseRequestId('wallet');
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 2500));
  const retryIntervalMs = Math.max(0, Number(options.retryIntervalMs ?? 300));
  const version = options.version ?? HAZBASE_X402_BRIDGE_VERSION;

  if (!target?.postMessage || !globalThis.window?.addEventListener) {
    return Promise.resolve({ ok: false, id, reason: 'window_unavailable' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let retryTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: RequestWalletAddressResult) => {
      if (settled) return;
      settled = true;
      if (retryTimer) clearInterval(retryTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      globalThis.window.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const postRequest = () => {
      target.postMessage({
        type: HAZBASE_WALLET_ADDRESS_REQUEST,
        version,
        id,
        ...(options.purpose ? { purpose: options.purpose } : {}),
      }, origin);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== target) return;
      if (origin !== '*' && event.origin !== origin) return;
      const message = isRecord(event.data) ? event.data : null;
      if (!message || message.type !== HAZBASE_WALLET_ADDRESS_RESPONSE || message.id !== id) return;
      const address = normalizeEvmAddress(message.address);
      if (message.ok === true && address) {
        finish({ ok: true, id, address, message });
        return;
      }
      finish({
        ok: false,
        id,
        reason: typeof message.reason === 'string' ? message.reason : undefined,
        message,
      });
    };

    const onAbort = () => finish({ ok: false, id, reason: 'aborted' });

    globalThis.window.addEventListener('message', onMessage);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    postRequest();
    if (retryIntervalMs > 0) retryTimer = setInterval(postRequest, retryIntervalMs);
    timeoutTimer = setTimeout(() => finish({ ok: false, id, timedOut: true }), timeoutMs);
  });
}

export function createX402WalletUrl(
  walletUrl: string,
  x402: Record<string, unknown>,
  options: CreateX402WalletUrlOptions,
): string {
  const url = new URL(walletUrl);
  url.searchParams.set('x402', base64UrlEncode(JSON.stringify(x402)));
  url.searchParams.set('sourceUrl', options.sourceUrl);
  if (options.title) url.searchParams.set('title', options.title);
  if (options.completionMode === 'fragment') url.searchParams.set('x402Completion', 'fragment');
  if (options.completionParam) url.searchParams.set('x402CompletionParam', options.completionParam);
  return url.toString();
}

export function setX402RequestScript(
  x402: Record<string, unknown>,
  options: { scriptId?: string; sourceUrl?: string; completionMode?: 'fragment'; completionParam?: string } = {},
): void {
  const script = document.getElementById(options.scriptId ?? 'hazbase-x402-request') as HTMLScriptElement | null;
  if (!script) return;
  script.textContent = JSON.stringify(x402);
  if (options.sourceUrl) script.dataset.sourceUrl = options.sourceUrl;
  if (options.completionMode) script.dataset.completionMode = options.completionMode;
  if (options.completionParam) script.dataset.completionParam = options.completionParam;
}

export function saveX402Handoff(paymentRequestId: string, x402: Record<string, unknown>, options: SaveX402HandoffOptions): void {
  if (!paymentRequestId) return;
  const storage = options.storage ?? globalThis.localStorage;
  if (!storage) return;
  const key = `${options.storagePrefix ?? 'hazbase.x402.handoff.v1'}:${paymentRequestId}`;
  const payload = {
    paymentRequestId,
    x402,
    sourceUrl: options.sourceUrl,
    pageTitle: options.pageTitle,
    completionMode: options.completionMode,
    completionParam: options.completionParam,
    expiresAt: new Date(Date.now() + (options.ttlMs ?? 10 * 60 * 1000)).toISOString(),
  };
  try {
    storage.setItem(key, JSON.stringify(payload));
  } catch {
    // Best-effort handoff for same-origin wallet launches.
  }
}

export function removeX402UrlParams(paramNames: string[] = [
  'x402',
  'x402Body',
  'sourceUrl',
  'resourceUrl',
  'title',
  'x402Completion',
  'x402CompletionParam',
]): void {
  if (!globalThis.location || !globalThis.history) return;
  const url = new URL(globalThis.location.href);
  let changed = false;
  for (const name of paramNames) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (changed) globalThis.history.replaceState(null, '', url.toString());
}

export function publishX402Request(paymentRequestId: string, x402: Record<string, unknown>, options: PublishX402RequestOptions): void {
  setX402RequestScript(x402, {
    scriptId: options.scriptId,
    sourceUrl: options.sourceUrl,
    completionMode: options.completionMode,
    completionParam: options.completionParam,
  });
  saveX402Handoff(paymentRequestId, x402, options);
  removeX402UrlParams(options.removeUrlParams);
}

export function postX402BridgeRequest(options: PostX402BridgeRequestOptions): string {
  const id = options.id ?? createHazbaseRequestId('x402');
  const target = options.targetWindow ?? globalThis.window;
  target.postMessage({
    type: HAZBASE_X402_BRIDGE_REQUEST,
    version: HAZBASE_X402_BRIDGE_VERSION,
    id,
    sourceUrl: options.sourceUrl,
    ...(options.title ? { title: options.title } : {}),
    x402: options.x402,
    completion: {
      ...(options.completionMode ? { mode: options.completionMode } : {}),
      ...(options.completionParam ? { param: options.completionParam } : {}),
    },
  }, options.origin ?? globalThis.location?.origin ?? '*');
  return id;
}

function readX402Envelope(): HazbaseX402ContentEnvelope | null {
  const url = new URL(location.href);
  const encoded = url.searchParams.get('x402') || url.searchParams.get('x402Body');
  if (encoded) {
    const decoded = decodeX402Param(encoded);
    const x402 = decoded ? parseJsonRecord(decoded) : null;
    if (x402) {
      const completionParam = safeCompletionParam(url.searchParams.get('x402CompletionParam'));
      return {
        x402,
        sourceUrl: safeHttpsUrl(url.searchParams.get('sourceUrl') || url.searchParams.get('resourceUrl')) ||
          `${location.origin}${location.pathname}`,
        ...(url.searchParams.get('x402Completion') === 'fragment' ? { completionMode: 'fragment' } : {}),
        ...(completionParam ? { completionParam } : {}),
      };
    }
  }

  const script = document.querySelector<HTMLScriptElement>("script[type='application/x-x402+json']");
  const x402 = script?.textContent ? parseJsonRecord(script.textContent) : null;
  if (!x402) return null;
  const completionMode = script?.dataset.completionMode === 'fragment' ? 'fragment' : undefined;
  const completionParam = safeCompletionParam(script?.dataset.completionParam ?? null);
  return {
    x402,
    sourceUrl: safeHttpsUrl(script?.dataset.sourceUrl ?? null) || `${location.origin}${location.pathname}`,
    ...(completionMode ? { completionMode } : {}),
    ...(completionParam ? { completionParam } : {}),
  };
}

function bindX402Bridge(
  signal: AbortSignal,
  requestWalletOpen: (envelope: HazbaseX402ContentEnvelope) => Promise<unknown>,
  options: InstallHazbaseWalletContentBridgeOptions,
): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = isX402BridgeRequestMessage(event.data) ? event.data : null;
    if (!message) return;
    const completion = isRecord(message.completion) ? message.completion : {};
    const completionMode = completion.mode === 'fragment' ? 'fragment' : undefined;
    const completionParam = safeCompletionParam(typeof completion.param === 'string' ? completion.param : null);
    const envelope: HazbaseX402ContentEnvelope = {
      x402: message.x402,
      sourceUrl: safeHttpsUrl(message.sourceUrl) || `${location.origin}${location.pathname}`,
      bridgeRequestId: message.id,
      ...(completionMode ? { completionMode } : {}),
      ...(completionParam ? { completionParam } : {}),
    };
    void requestWalletOpen(envelope)
      .then((response) => {
        if (isRecord(response) && response.ok === true) {
          postBridgeMessage({
            type: HAZBASE_X402_BRIDGE_DETECTED,
            version: HAZBASE_X402_BRIDGE_VERSION,
            id: message.id,
            wallet: {
              name: options.walletName ?? 'hazBase Wallet',
              extensionId: options.runtime?.id ?? defaultRuntime()?.id,
            },
            capabilities: {
              sidePanel: true,
              pwaHandoff: true,
              postMessagePayment: true,
              ...(options.capabilities ?? {}),
            },
          });
          return;
        }
        postBridgeMessage({
          type: HAZBASE_X402_BRIDGE_ERROR,
          version: HAZBASE_X402_BRIDGE_VERSION,
          id: message.id,
          code: 'wallet_open_failed',
          message: isRecord(response) && typeof response.reason === 'string'
            ? response.reason
            : options.walletOpenFailedMessage ?? 'Wallet could not open this request.',
        });
      })
      .catch((error) => {
        postBridgeMessage({
          type: HAZBASE_X402_BRIDGE_ERROR,
          version: HAZBASE_X402_BRIDGE_VERSION,
          id: message.id,
          code: 'wallet_open_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, { signal });
}

function bindReceiveAddressBridge(
  signal: AbortSignal,
  runtime: HazbaseRuntimeLike | undefined,
  options: InstallHazbaseWalletContentBridgeOptions,
): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const record = isRecord(event.data) ? event.data : {};
    const isGenericRequest = record.type === HAZBASE_WALLET_ADDRESS_REQUEST;
    const isLegacyRequest = options.legacyAddressRequestType && record.type === options.legacyAddressRequestType;
    if (!isGenericRequest && !isLegacyRequest) return;
    const requestId = typeof record.id === 'string'
      ? record.id
      : typeof record.requestId === 'string'
        ? record.requestId
        : '';
    if (!requestId) return;
    runtime?.sendMessage?.({ type: options.receiveAddressMessageType }, (response: unknown) => {
      const error = runtime?.lastError;
      const body = isRecord(response) ? response : {};
      postBridgeMessage({
        type: isGenericRequest ? HAZBASE_WALLET_ADDRESS_RESPONSE : options.legacyAddressResponseType,
        version: HAZBASE_X402_BRIDGE_VERSION,
        id: requestId,
        requestId,
        ...(error ? { ok: false, reason: error.message || options.unavailableMessage || 'Wallet extension is unavailable.' } : body),
      });
    });
  }, { signal });
}

function bindRuntimeBridge(
  signal: AbortSignal,
  runtime: HazbaseRuntimeLike | undefined,
  options: InstallHazbaseWalletContentBridgeOptions,
): void {
  const listener = (message: unknown) => {
    const record = isRecord(message) ? message : {};
    const bridgeRequestId = typeof record.bridgeRequestId === 'string' ? record.bridgeRequestId : '';
    if (record.type === options.runtimeCancelledMessageType) {
      if (!bridgeRequestId) return;
      postBridgeMessage({
        type: HAZBASE_X402_BRIDGE_ERROR,
        version: HAZBASE_X402_BRIDGE_VERSION,
        id: bridgeRequestId,
        code: 'user_cancelled',
        message: options.paymentCancelledMessage ?? 'The payment was cancelled in the wallet.',
      });
      return;
    }
    if (record.type !== options.runtimePaymentMessageType) return;
    const paymentRequestId = typeof record.paymentRequestId === 'string' ? record.paymentRequestId : '';
    const xPayment = typeof record.xPayment === 'string' ? record.xPayment : '';
    if (!bridgeRequestId || !paymentRequestId || !xPayment) return;
    postBridgeMessage({
      type: HAZBASE_X402_BRIDGE_PAYMENT,
      version: HAZBASE_X402_BRIDGE_VERSION,
      id: bridgeRequestId,
      paymentRequestId,
      xPayment,
    });
  };
  runtime?.onMessage?.addListener?.(listener);
  signal.addEventListener('abort', () => {
    runtime?.onMessage?.removeListener?.(listener);
  }, { once: true });
}

function postBridgeMessage(message: Record<string, unknown>): void {
  window.postMessage(message, location.origin);
}

function isX402BridgeRequestMessage(value: unknown): value is {
  type: typeof HAZBASE_X402_BRIDGE_REQUEST;
  version: typeof HAZBASE_X402_BRIDGE_VERSION;
  id: string;
  sourceUrl: string;
  x402: Record<string, unknown>;
  completion?: Record<string, unknown>;
} {
  return (
    isRecord(value) &&
    value.type === HAZBASE_X402_BRIDGE_REQUEST &&
    value.version === HAZBASE_X402_BRIDGE_VERSION &&
    typeof value.id === 'string' &&
    typeof value.sourceUrl === 'string' &&
    isRecord(value.x402) &&
    (value.completion === undefined || isRecord(value.completion))
  );
}

function safeHttpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function defaultRuntime(): HazbaseRuntimeLike | undefined {
  return (globalThis as typeof globalThis & { chrome?: { runtime?: HazbaseRuntimeLike } }).chrome?.runtime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
