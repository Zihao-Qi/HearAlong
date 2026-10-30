// Pi 1.3.0's GrepOperations still invokes ensureTool("rg"). Replace execution, not the tool contract.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Worker } from 'node:worker_threads';
import { createFindToolDefinition } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.js';
import { createGrepToolDefinition } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js';
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js';

export type SearchEntry = { path: string; directory: boolean; identity: string };
export type SearchName = 'grep' | 'find';
type SearchOutput = { text: string; limitReached?: number; linesTruncated?: boolean;
  skippedFiles: { unreadable: number; nonRegular: number; unsafePath: number }; searchFiles: SearchEntry[] };
type PrepareSearch = (name: SearchName, input: Record<string, unknown>, cwd: string) => SearchEntry[];
const RUNNER = new URL('./node-search-runner.cjs', import.meta.url);

function search(name: SearchName, input: Record<string, unknown>, entries: SearchEntry[], signal?: AbortSignal): Promise<SearchOutput> {
  if (signal?.aborted) return Promise.reject(new Error('Operation aborted'));
  return new Promise((resolve, reject) => {
    // Regex evaluation stays off Pi's event loop, so even a pathological pattern can be cancelled.
    const worker = new Worker(RUNNER, { workerData: { name, input, entries, maxBytes: DEFAULT_MAX_BYTES, maxLineChars: GREP_MAX_LINE_LENGTH },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 }, execArgv: [], env: {} });
    let settled = false;
    const finish = (error?: Error, output?: SearchOutput) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      void worker.terminate().then(() => { if (error) reject(error); else resolve(output!); }, reject);
    };
    const abort = () => finish(new Error('Operation aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: { error?: string; output?: SearchOutput }) => finish(message.error ? new Error(message.error) : undefined, message.output));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`Search worker exited without a result (${code})`)); });
    if (signal?.aborted) abort();
  });
}

export function registerNodeSearch(pi: ExtensionAPI, prepare: PrepareSearch) {
  const scopeNote = ' Searches only scope-clean trees. Hidden/excluded descendants cause refusal, including .gitignore; ancestor/global ignore files are not read.';
  const grep = createGrepToolDefinition('.');
  const find = createFindToolDefinition('.');
  pi.registerTool({ ...grep,
    description: grep.description.replace('Respects .gitignore.', 'Uses JavaScript line regexes (or literal strings); binary, unreadable, non-regular and control-character paths are skipped. Lines over 8 MiB or changed file identities cause an explicit error.') + scopeNote,
    promptSnippet: 'Search permitted file contents using a regex or literal string (no external tools)',
    async execute(_id, input, signal, _update, ctx) {
      if (signal?.aborted) throw new Error('Operation aborted');
      const entries = prepare('grep', input, ctx.cwd);
      return result('grep', await search('grep', input, entries, signal));
    },
  });
  pi.registerTool({ ...find,
    description: find.description.replace('Respects .gitignore.', 'Control-character paths are skipped and counted.') + scopeNote,
    promptSnippet: 'Find permitted files and folders by glob (no external tools)',
    async execute(_id, input, signal, _update, ctx) {
      if (signal?.aborted) throw new Error('Operation aborted');
      const entries = prepare('find', input, ctx.cwd);
      return result('find', await search('find', input, entries, signal));
    },
  });
}

function result(name: SearchName, output: SearchOutput) {
  const truncation = truncateHead(output.text, { maxLines: Number.MAX_SAFE_INTEGER });
  const details: Record<string, unknown> = {}, notices: string[] = [];
  if (name === 'grep') details.searchFiles = output.searchFiles;
  const skipped = output.skippedFiles;
  if (skipped.unreadable || skipped.nonRegular || skipped.unsafePath) {
    details.skippedFiles = skipped;
    notices.push(`Skipped ${skipped.unreadable} unreadable, ${skipped.nonRegular} non-regular, ${skipped.unsafePath} control-character paths`);
  }
  if (output.limitReached !== undefined) {
    const kind = name === 'grep' ? 'matches' : 'results';
    notices.push(`${output.limitReached} ${kind} limit reached. Use limit=${output.limitReached * 2} for more, or refine pattern`);
    details[name === 'grep' ? 'matchLimitReached' : 'resultLimitReached'] = output.limitReached;
  }
  if (truncation.truncated) { notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`); details.truncation = truncation; }
  if (output.linesTruncated) { notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`); details.linesTruncated = true; }
  return { content: [{ type: 'text' as const, text: truncation.content + (notices.length ? `\n\n[${notices.join('. ')}]` : '') }],
    details: Object.keys(details).length ? details : undefined };
}
