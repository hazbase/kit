import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HAZBASE_WALLET_LINK_REQUEST,
  HAZBASE_WALLET_LINK_RESPONSE,
  consumeAndVerifyWalletLinkFromFragment,
  consumeWalletLinkProofFromFragment,
  createWalletLinkPwaUrl,
  createWalletLinkReturnUrl,
  readWalletLinkHandoffFromUrl,
  requestWalletLink,
} from '../dist/extension.mjs';
import {
  DEFAULT_HAZBASE_API_ENDPOINT,
  createHazbaseWalletClient,
} from '../dist/wallet.mjs';

const challenge = {
  challengeId: 'challenge-1',
  nonce: 'nonce-1',
  origin: 'https://merchant.example',
  purpose: 'card_holdings',
  expiresAt: '2026-07-14T12:00:00.000Z',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createWalletLinkFetcher(calls, options = {}) {
  return async (input, init = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (url.endsWith('/api/wallet/link/challenge')) return jsonResponse(challenge);
    if (url.endsWith('/api/wallet/link/approve')) {
      return jsonResponse({ challengeId: challenge.challengeId, proof: 'proof-1', expiresAt: challenge.expiresAt });
    }
    if (url.endsWith('/api/wallet/link/verify')) {
      if (options.failVerification) return jsonResponse({ message: 'temporarily unavailable' }, 503);
      return jsonResponse({
        verified: true,
        walletAddress: '0x1111111111111111111111111111111111111111',
        chainId: 11155111,
        origin: challenge.origin,
        purpose: challenge.purpose,
        assurance: 'authenticated_wallet_session',
        expiresAt: challenge.expiresAt,
        linkSessionToken: 'link-session-1',
        linkSessionExpiresAt: '2026-07-21T12:00:00.000Z',
      });
    }
    if (url.endsWith('/api/wallet/link/session/verify')) {
      return jsonResponse({
        verified: true,
        linkSessionId: 'link-session-id-1',
        walletAddress: '0x1111111111111111111111111111111111111111',
        chainId: 11155111,
        origin: challenge.origin,
        purpose: challenge.purpose,
        assurance: 'authenticated_wallet_session',
        linkSessionExpiresAt: '2026-07-21T12:00:00.000Z',
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

class FakeWindow {
  constructor(onPostMessage) {
    this.listeners = new Set();
    this.onPostMessage = onPostMessage;
  }

  addEventListener(type, listener) {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(message, origin) {
    this.onPostMessage?.(message, origin, this);
  }

  dispatchMessage(data, origin, source = this) {
    for (const listener of [...this.listeners]) listener({ data, origin, source });
  }
}

test('wallet-link client uses the default endpoint and expected request contracts', async () => {
  const calls = [];
  const client = createHazbaseWalletClient({
    fetcher: createWalletLinkFetcher(calls),
    requestId: () => 'request-1',
  });

  await client.createWalletLinkChallenge({ origin: challenge.origin, purpose: challenge.purpose });
  await client.approveWalletLink({
    emailSession: 'email-session-1',
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    walletAddress: '0x1111111111111111111111111111111111111111',
    chainId: 11155111,
  });
  await client.verifyWalletLink({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    proof: 'proof-1',
    origin: challenge.origin,
  });
  await client.verifyWalletLinkSession({
    linkSessionToken: 'link-session-1',
    origin: challenge.origin,
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, `${DEFAULT_HAZBASE_API_ENDPOINT}/api/wallet/link/challenge`);
  assert.deepEqual(calls[0].body, { origin: challenge.origin, purpose: challenge.purpose });
  assert.equal(calls[1].init.headers.authorization, 'Bearer email-session-1');
  assert.equal(calls[1].init.headers['x-request-id'], 'request-1');
  assert.deepEqual(calls[2].body, {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    proof: 'proof-1',
    origin: challenge.origin,
  });
  assert.deepEqual(calls[3].body, {
    linkSessionToken: 'link-session-1',
    origin: challenge.origin,
  });
});

test('PWA handoff round-trips a proof and rejects a cross-origin return URL', () => {
  const pwaUrl = createWalletLinkPwaUrl('https://wallet.example/pwa/', {
    challenge,
    returnUrl: 'https://merchant.example/cards?view=collection',
  });
  assert.deepEqual(readWalletLinkHandoffFromUrl(pwaUrl), {
    challenge,
    returnUrl: 'https://merchant.example/cards?view=collection',
  });

  const returnUrl = createWalletLinkReturnUrl('https://merchant.example/cards?view=collection', {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    proof: 'proof-1',
  });
  assert.deepEqual(consumeWalletLinkProofFromFragment(returnUrl, false), {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    proof: 'proof-1',
  });

  assert.throws(() => createWalletLinkPwaUrl('https://wallet.example/pwa/', {
    challenge,
    returnUrl: 'https://attacker.example/collect',
  }), /wallet_link_return_origin_mismatch/u);
});

test('requestWalletLink verifies an extension proof before returning the address', async () => {
  const calls = [];
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  const fakeWindow = new FakeWindow((message, origin, source) => {
    assert.equal(message.type, HAZBASE_WALLET_LINK_REQUEST);
    queueMicrotask(() => source.dispatchMessage({
      type: HAZBASE_WALLET_LINK_RESPONSE,
      version: 1,
      id: message.id,
      ok: true,
      proof: 'proof-1',
    }, origin));
  });
  globalThis.window = fakeWindow;
  globalThis.location = { origin: challenge.origin };
  try {
    const result = await requestWalletLink({
      fetcher: createWalletLinkFetcher(calls),
      timeoutMs: 100,
      retryIntervalMs: 0,
      purpose: challenge.purpose,
    });
    assert.equal(result.ok, true);
    assert.equal(result.walletAddress, '0x1111111111111111111111111111111111111111');
    assert.equal(result.linkSessionToken, 'link-session-1');
    assert.equal(calls.length, 2);
  } finally {
    globalThis.window = previousWindow;
    globalThis.location = previousLocation;
  }
});

test('a failed return verification leaves the URL proof available for retry', async () => {
  const input = createWalletLinkReturnUrl('https://merchant.example/cards', {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    proof: 'proof-1',
  });
  await assert.rejects(
    consumeAndVerifyWalletLinkFromFragment({
      input,
      origin: challenge.origin,
      fetcher: createWalletLinkFetcher([], { failVerification: true }),
    }),
    /temporarily unavailable/u,
  );
  assert.deepEqual(consumeWalletLinkProofFromFragment(input, false), {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    proof: 'proof-1',
  });
});

test('requestWalletLink exits immediately for an already-aborted request', async () => {
  const controller = new AbortController();
  controller.abort();
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  globalThis.window = new FakeWindow();
  globalThis.location = { origin: challenge.origin };
  try {
    const result = await requestWalletLink({
      fetcher: createWalletLinkFetcher([]),
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'aborted');
  } finally {
    globalThis.window = previousWindow;
    globalThis.location = previousLocation;
  }
});
