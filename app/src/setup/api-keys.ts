import { spawn } from 'node:child_process';
import { KEY_PROVIDERS, envProvides, setPiKeys, type KeyProvider } from '../pi-command.ts';
import type { PiModels } from './pi-models.ts';

/** What the dialog names, where a key comes from, and the free model-list endpoint that checks one (base overridable for tests). */
export const KEY_SOURCES: Record<KeyProvider, { company: string; baseEnv: string; base: string }> = {
  google: { company: 'Google', baseEnv: 'MEETING_GOOGLE_API_BASE', base: 'https://generativelanguage.googleapis.com' },
  openai: { company: 'OpenAI', baseEnv: 'MEETING_OPENAI_API_BASE', base: 'https://api.openai.com' },
  anthropic: { company: 'Anthropic', baseEnv: 'MEETING_ANTHROPIC_API_BASE', base: 'https://api.anthropic.com' },
};
const PROVIDERS = Object.keys(KEY_PROVIDERS) as KeyProvider[];
const SERVICE = 'HearAlong';
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * Keys in the login Keychain through /usr/bin/security (MEETING_SECURITY for tests). A key never appears in any argv: it is
 * written by `security -i` from stdin, hex-encoded (-X), so no quoting can break it; it is read back from stdout.
 */
export class Keychain {
  readonly command: string;
  private readonly target: string[];
  constructor(command = process.env.MEETING_SECURITY ?? '/usr/bin/security', keychain?: string) {
    if (keychain !== undefined && !/^[^\s"'\\]+$/.test(keychain)) throw new Error('A keychain path cannot contain spaces or quotes.');
    this.command = command; this.target = keychain ? [keychain] : [];
  }
  private run(args: string[], input = ''): Promise<{ code: number | null; stdout: string }> {
    return new Promise(resolve => {
      const child = spawn(this.command, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 15_000, killSignal: 'SIGKILL' });
      let stdout = '';
      child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (part: string) => { stdout = (stdout + part).slice(0, 8192); });
      child.stdin!.on('error', () => {}); child.stdin!.end(input);
      child.on('error', () => resolve({ code: null, stdout: '' }));
      child.on('close', code => resolve({ code, stdout }));
    });
  }
  async read(provider: KeyProvider): Promise<string | null> {
    const { code, stdout } = await this.run(['find-generic-password', '-s', SERVICE, '-a', provider, '-w', ...this.target]);
    if (code === 44) return null; // not found
    if (code !== 0) throw new Error('Couldn’t read the key from this Mac’s Keychain.');
    return stdout.replace(/\n$/, '');
  }
  async write(provider: KeyProvider, key: string): Promise<void> {
    const hex = Buffer.from(key, 'utf8').toString('hex');
    await this.run(['-i'], `add-generic-password -U -s ${SERVICE} -a ${provider} -X ${hex}${this.target.map(path => ` ${path}`).join('')}\n`);
    // `security -i` reports no failure in its exit code; reading the item back is the proof.
    if (await this.read(provider).catch(() => null) !== key) throw new Error('Couldn’t save the key in this Mac’s Keychain.');
  }
  async remove(provider: KeyProvider): Promise<void> {
    const { code } = await this.run(['delete-generic-password', '-s', SERVICE, '-a', provider, ...this.target]);
    if (code !== 0 && code !== 44) throw new Error('Couldn’t remove the key from this Mac’s Keychain.');
  }
}

/** Asks the provider's free model list whether it accepts the key. No tokens are spent; nothing the provider says is shown. */
export async function checkKey(provider: KeyProvider, key: string, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<void> {
  const { company, baseEnv, base: fallback } = KEY_SOURCES[provider];
  const base = (env[baseEnv] || fallback).replace(/\/+$/, '');
  const [url, headers]: [string, Record<string, string>] = provider === 'google' ? [`${base}/v1beta/models?pageSize=1`, { 'x-goog-api-key': key }]
    : provider === 'openai' ? [`${base}/v1/models`, { authorization: `Bearer ${key}` }]
    : [`${base}/v1/models?limit=1`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }];
  let response: Response;
  // No redirects: a key header must never follow one to another host.
  try { response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw Object.assign(failure(502, `Couldn’t reach ${company}. Check the connection.`), { code: 'unreachable' }); }
  await response.body?.cancel().catch(() => {});
  if (response.ok) return;
  // Google answers an unknown key with 400; the others with 401 or 403.
  if ([400, 401, 403].includes(response.status)) throw Object.assign(failure(400, `${company} didn’t accept this key. Check it and try again.`), { code: 'rejected' });
  throw Object.assign(failure(502, `${company} couldn’t check the key right now (HTTP ${response.status}). Try again later.`), { code: 'unavailable' });
}

/**
 * How each provider reaches Pi. `none`: no credential, a key can be added. `saved`: HearAlong's key is used. `pi`: Pi's own
 * sign-in. `env`: a credential in HearAlong's environment. `shadowed`: a saved key that Pi's sign-in (`by: pi`) or the
 * environment (`by: env`) overrides. `unconfirmed`: a change HearAlong could not undo may have left another key in the Keychain;
 * it is never used, only offered for removal. Never the key itself: only its last four characters.
 */
export type KeyState = { provider: KeyProvider; state: 'none' | 'saved' | 'pi' | 'env' | 'shadowed' | 'unconfirmed'; by?: 'pi' | 'env'; last4?: string; models?: number };
/** What settings.json holds: provider names only. */
export type SavedKeys = { apiKeys: KeyProvider[]; apiKeysUnconfirmed: KeyProvider[] };
export type ApiKeysOptions = {
  saved: () => SavedKeys; persist: (change: SavedKeys) => Promise<void>;
  reader: PiModels; keychain?: Keychain; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; clock?: () => number;
  log?: (message: string) => void;
};
export class ApiKeys {
  private keys = new Map<KeyProvider, string>();
  private unconfirmed = new Set<KeyProvider>();
  private closed = false;
  private signedIn = new Map<KeyProvider, { at: number; ready: Promise<boolean> }>();
  private mutations: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void> = Promise.resolve();
  readonly options: ApiKeysOptions;
  readonly keychain: Keychain;
  constructor(options: ApiKeysOptions) { this.options = options; this.keychain = options.keychain ?? new Keychain(); }
  private get env() { return this.options.env ?? process.env; }
  private publish() { setPiKeys(Object.fromEntries(this.keys)); }
  /** Reads only the keys saved before, so a Mac without any never touches the Keychain. */
  load(): Promise<void> {
    this.loaded = (async () => {
      const saved = this.options.saved();
      for (const provider of saved.apiKeysUnconfirmed) this.unconfirmed.add(provider);
      await Promise.all(saved.apiKeys.filter(provider => !this.unconfirmed.has(provider)).map(async provider => {
        try {
          const key = await this.keychain.read(provider);
          if (key) this.keys.set(provider, key);
          else this.options.log?.(`The saved ${KEY_SOURCES[provider].company} key is no longer in the Keychain.`);
        } catch (error) { this.options.log?.((error as Error).message); }
      }));
      this.publish();
    })();
    return this.loaded;
  }
  ready() { return this.loaded; }
  /** Pi's own credential for a provider (asked without HearAlong's key), for a few seconds; an unknown answer counts as none. */
  private piSignedIn(provider: KeyProvider, fresh = false): Promise<boolean> {
    const now = (this.options.clock ?? Date.now)(), cached = this.signedIn.get(provider);
    if (!fresh && cached && now - cached.at < 10_000) return cached.ready;
    const ready = this.options.reader.providerAuth(provider, false).then(result => result === 'ready');
    this.signedIn.set(provider, { at: now, ready });
    return ready;
  }
  async list(fresh = false): Promise<KeyState[]> {
    await this.loaded;
    const models = this.options.reader.last?.state === 'ok' ? this.options.reader.last.models : [];
    return Promise.all(PROVIDERS.map(async (provider): Promise<KeyState> => {
      if (this.unconfirmed.has(provider)) return { provider, state: 'unconfirmed' };
      const key = this.keys.get(provider);
      const by = envProvides(this.env, provider) ? 'env' : await this.piSignedIn(provider, fresh) ? 'pi' : undefined;
      if (!key) return { provider, state: by ?? 'none' };
      const detail = { last4: key.slice(-4), models: models.filter(m => m.provider === provider).length };
      return by ? { provider, state: 'shadowed', by, ...detail } : { provider, state: 'saved', ...detail };
    }));
  }
  private open() { if (this.closed) throw failure(503, 'Server is shutting down.'); }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(failure(503, 'Server is shutting down.'));
    const run = this.mutations.catch(() => {}).then(() => { this.open(); return work(); });
    this.mutations = run;
    return run;
  }
  private async persist() {
    await this.options.persist({ apiKeys: PROVIDERS.filter(p => this.keys.has(p)), apiKeysUnconfirmed: PROVIDERS.filter(p => this.unconfirmed.has(p)) });
  }
  /**
   * Validates, stores and confirms a key. Any failure once the Keychain write has started puts the previous key back (or removes
   * the item) and checks that it did; if that cannot be shown, the error says the key on this Mac may have changed and the
   * provider is kept as unconfirmed (never used) until the key is removed.
   */
  add(provider: KeyProvider, value: unknown): Promise<void> {
    return this.queue(async () => {
      await this.loaded;
      const key = typeof value === 'string' ? value.trim() : '';
      const company = KEY_SOURCES[provider].company;
      if (!/^[\x21-\x7e]{8,512}$/.test(key)) throw failure(400, 'This doesn’t look like an API key.');
      if (envProvides(this.env, provider)) throw failure(409, `HearAlong’s environment already gives Pi a ${company} key.`);
      await checkKey(provider, key, this.env, this.options.fetch);
      this.open();
      const previous = this.unconfirmed.has(provider) ? undefined : this.keys.get(provider);
      let reason = `Couldn’t save the ${company} key in this Mac’s Keychain`, rejected = false;
      try {
        await this.keychain.write(provider, key);
        this.keys.set(provider, key); this.unconfirmed.delete(provider); this.publish();
        reason = `Couldn’t save the ${company} key`;
        await this.persist();
        this.signedIn.delete(provider);
        // Pi must find a credential with the key; whether it is this key or Pi's own sign-in, the list then says.
        if (await this.options.reader.providerAuth(provider, true) === 'not_ready') { reason = 'Pi didn’t pick up the key'; rejected = true; throw new Error(reason); }
      } catch {
        if (await this.restore(provider, previous)) throw failure(rejected ? 502 : 500, rejected ? 'Pi didn’t pick up the key. Nothing was saved.' : `${reason}. Nothing was changed.`);
        throw failure(500, `${reason}, and the ${company} key on this Mac may have changed. Remove it and add it again.`);
      }
    });
  }
  /** Puts the previous key back (or removes the item) and reads it back; true when that is shown. */
  private async restore(provider: KeyProvider, previous: string | undefined): Promise<boolean> {
    let verified = false;
    try {
      if (previous) await this.keychain.write(provider, previous); // Keychain.write reads the item back
      else { await this.keychain.remove(provider); if (await this.keychain.read(provider) !== null) throw new Error('still there'); }
      verified = true;
    } catch { /* reported by the caller */ }
    if (verified && previous) this.keys.set(provider, previous);
    else { this.keys.delete(provider); if (!verified) this.unconfirmed.add(provider); }
    this.publish();
    await this.persist().catch(error => this.options.log?.(`Couldn’t record the ${KEY_SOURCES[provider].company} key’s state: ${(error as Error).message}`));
    return verified;
  }
  remove(provider: KeyProvider): Promise<void> {
    return this.queue(async () => {
      await this.loaded;
      await this.keychain.remove(provider);
      if (await this.keychain.read(provider) !== null) throw failure(500, 'Couldn’t remove the key from this Mac’s Keychain.');
      this.keys.delete(provider); this.unconfirmed.delete(provider); this.publish(); this.signedIn.delete(provider);
      await this.persist();
    });
  }
  /** No change is accepted from now on (a request still arriving during shutdown is refused). */
  seal() { this.closed = true; }
  async close() {
    this.seal();
    await this.mutations.catch(() => {});
    setPiKeys({});
  }
}
