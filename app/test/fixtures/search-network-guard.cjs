// Loaded before the real Pi CLI. Never let an offline search regression reach the network.
const { appendFileSync } = require('node:fs');
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== process.env.SEARCH_FIXTURE_ORIGIN) {
    appendFileSync(process.env.SEARCH_NETWORK_LOG, `${url.href}\n`);
    return Promise.reject(new Error(`Fixture blocked network: ${url.origin}`));
  }
  return originalFetch(input, init);
};
