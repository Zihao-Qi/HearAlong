#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const EMAIL = '35388022+Zihao-Qi@users.noreply.github.com';
const MAX_BYTES = 2_000_000; // 2 MB, decimal; check the staged/committed blob, not the working file.
const WORD = /[\p{L}\p{M}\p{N}_]/u;
let failed = false;
let context = '';

function reject(message) {
  console.error(`Privacy guard${context}: ${message}`);
  failed = true;
}

function gitOutput(args, encoding = 'utf8', allowDifference = false) {
  try {
    return execFileSync('git', args, {
      encoding, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowDifference && error.status === 1 && error.stdout !== undefined) return error.stdout;
    // Do not echo Git's output: it can include private content or external helper output.
    throw new Error('Git inspection failed; resolve index/history issues and fetch missing history, then retry.');
  }
}

function git(...args) {
  return gitOutput(args);
}

function bomEncoding(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  return null;
}

function decode(bytes) {
  return new TextDecoder(bomEncoding(bytes) || 'utf-8').decode(bytes);
}

function loadTerms() {
  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const list = path.join(path.dirname(commonDir), 'private/public-denylist.txt');
  let text;
  try {
    text = decode(fs.readFileSync(list));
  } catch {
    throw new Error('Cannot read the main working tree\'s private/public-denylist.txt; restore your local deny list there, then retry.');
  }
  const terms = text.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  if (!terms.length) throw new Error('Empty deny list; restore terms in the main working tree\'s private/public-denylist.txt and retry.');
  return terms.map(term => {
    const literal = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Punctuation at a term's edge already separates words: slash-delimited
    // path fragments must still match when followed by a username or filename.
    const start = WORD.test([...term][0]) ? '(?<![\\p{L}\\p{M}\\p{N}_])' : '';
    const end = WORD.test([...term].at(-1)) ? '(?![\\p{L}\\p{M}\\p{N}_])' : '';
    return { term, pattern: new RegExp(start + literal + end, 'iu') };
  });
}

function checkLine(terms, path, number, text) {
  for (const { term, pattern } of terms) {
    if (pattern.test(text)) {
      reject(`${JSON.stringify(path)}:${number}: deny-list term ${JSON.stringify(term)}; remove it and rewrite affected commits/tags before pushing.`);
    }
  }
}

function checkText(terms, label, text) {
  text.split('\n').forEach((line, index) => checkLine(terms, label, index + 1, line));
}

function objectParts(type, id) {
  const raw = gitOutput(['cat-file', type, id], null);
  const separator = raw.indexOf('\n\n');
  if (separator < 0) throw new Error('Cannot inspect object message; recreate the commit or tag and retry.');
  return [raw.subarray(0, separator).toString('utf8'), decode(raw.subarray(separator + 2))];
}

function commitMsg(terms) {
  let message;
  try {
    message = decode(fs.readFileSync(process.argv[3]));
  } catch {
    throw new Error('Cannot read commit message; retry the commit with a readable message file.');
  }
  const comment = git('config', '--default', '#', '--get', 'core.commentChar').replace(/\n$/, '');
  if (comment.length !== 1) throw new Error('Set core.commentChar to a single literal character, then retry.');
  const scissors = ' ------------------------ >8 ------------------------';
  const lines = message.split('\n');
  const cut = lines.findIndex(line => line.replace(/\r$/, '') === `#${scissors}` || line.replace(/\r$/, '') === `${comment}${scissors}`);
  const stored = (cut < 0 ? lines : lines.slice(0, cut)).filter(line => !line.startsWith(comment));
  checkText(terms, 'commit message', stored.join('\n'));
}

function checkIdentity(terms, label, ident) {
  const match = /^(.*) <([^<>]*)> \d+ [+-]\d{4}$/.exec(ident);
  if (!match) throw new Error(`Cannot inspect ${label}; configure a valid name and email, then recreate it.`);
  checkLine(terms, `${label} name`, 1, match[1]);
  checkLine(terms, `${label} email`, 1, match[2]);
  if (match[2] !== EMAIL) reject(`${label} email must be ${EMAIL}; configure the correct identity and recreate it.`);
}

function checkTagMessages(id, terms, checked) {
  // Nested annotated tags can each carry a public message. Inspect all of them,
  // even when the target commit is already on a remote-tracking branch.
  while (git('cat-file', '-t', id).trim() === 'tag') {
    if (checked.has(id)) return;
    checked.add(id);
    context = ` (tag ${id.slice(0, 12)})`;
    const [headers, message] = objectParts('tag', id);
    const tagName = /^tag (.*)$/m.exec(headers);
    const tagger = /^tagger (.*)$/m.exec(headers);
    if (!tagName || !tagger) throw new Error('Cannot inspect tag name/tagger; recreate the annotated tag and retry.');
    checkLine(terms, 'annotated tag name', 1, tagName[1]);
    checkIdentity(terms, 'tagger', tagger[1]);
    checkText(terms, 'tag message', message);
    const target = /^object ([0-9a-f]{40}|[0-9a-f]{64})$/m.exec(headers);
    if (!target) throw new Error('Cannot inspect tag target; recreate the tag and retry.');
    id = target[1];
  }
}

function checkFiles(raw, terms) {
  const fields = raw.split('\0');
  for (let i = 0; fields[i];) {
    const header = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])[0-9]*$/.exec(fields[i++]);
    if (!header) throw new Error('Cannot inspect the index; resolve conflicts and stage files again.');
    const [, , mode, oldId, newId, status] = header;
    let path = fields[i++];
    if (status === 'R' || status === 'C') path = fields[i++];
    if (path === undefined) throw new Error('Cannot parse changed paths; retry with a resolved index.');
    if (status === 'D') continue;
    if (status === 'U' || /^0+$/.test(newId)) throw new Error('Resolve merge conflicts and stage files again.');

    if (status === 'A' || status === 'R' || status === 'C') checkLine(terms, path, 1, path);

    // Match these names at the root (including files/symlinks), and prototype runtime paths at any depth.
    if (/^(private|data|evaluation)(\/|$)/i.test(path) || /(^|\/)prototype\/(data|artifacts)\//i.test(path)) {
      reject(`${JSON.stringify(path)}: private/runtime path; unstage or remove it and rewrite affected commits.`);
    }
    if (/\.(wav|f32|sqlite|db|m4a|mp3|mp4|webm|gguf|media)$/i.test(path)) {
      reject(`${JSON.stringify(path)}: blocked extension; unstage or remove it and rewrite affected commits.`);
    }
    const baseName = path.slice(path.lastIndexOf('/') + 1);
    if ((baseName === '.env' || baseName.startsWith('.env.')) && baseName !== '.env.example') {
      reject(`${JSON.stringify(path)}: environment file; use .env.example with public placeholders or remove it and rewrite affected commits.`);
    }
    if (mode === '160000') {
      // A gitlink has no local file contents to inspect. Never silently skip one.
      reject(`${JSON.stringify(path)}: cannot inspect submodule contents; remove the gitlink before sharing.`);
      continue;
    }
    const size = Number(git('cat-file', '-s', newId).trim());
    if (!Number.isSafeInteger(size)) throw new Error('Cannot read blob size; repair the repository and retry.');
    if (size > MAX_BYTES) {
      reject(`${JSON.stringify(path)}: larger than 2 MB; remove it or reduce it to at most ${MAX_BYTES} bytes and rewrite affected commits.`);
      continue;
    }
    if (oldId === newId) continue; // Pure rename/mode change: no added lines.
    const newBytes = gitOutput(['cat-file', 'blob', newId], null);
    if (/^0+$/.test(oldId) || status === 'C') {
      checkText(terms, path, decode(newBytes));
    } else {
      const oldBytes = gitOutput(['cat-file', 'blob', oldId], null);
      // Normalize BOM-marked encodings before diffing so unchanged/deleted text
      // still does not count as an addition. Never use attributes/diff helpers.
      const patch = bomEncoding(oldBytes) || bomEncoding(newBytes)
        ? decodedDiff(decode(oldBytes), decode(newBytes))
        : git('diff', ...DIFF, oldId, newId);
      let lineNumber = null;
      for (const line of patch.split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) lineNumber = Number(hunk[1]);
        else if (lineNumber !== null && line.startsWith('+')) checkLine(terms, path, lineNumber++, line.slice(1));
        else if (lineNumber !== null && line.startsWith(' ')) lineNumber++;
      }
    }
  }
}

const RAW = ['--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none'];
const DIFF = ['--text', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0',
  '--inter-hunk-context=0', '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= '];

function decodedDiff(before, after) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearalong-guard-diff-'));
  try {
    const oldFile = path.join(dir, 'before'), newFile = path.join(dir, 'after');
    fs.writeFileSync(oldFile, before, { mode: 0o600 });
    fs.writeFileSync(newFile, after, { mode: 0o600 });
    return gitOutput(['diff', '--no-index', ...DIFF, '--', oldFile, newFile], 'utf8', true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function preCommit(terms) {
  if (git('config', '--default', '', '--get', 'user.email').trim() !== EMAIL) {
    reject(`set git config user.email ${EMAIL}, then retry.`);
  }
  checkIdentity(terms, 'author', git('var', 'GIT_AUTHOR_IDENT').trim());
  checkIdentity(terms, 'committer', git('var', 'GIT_COMMITTER_IDENT').trim());
  checkFiles(git('diff', '--cached', ...RAW), terms);
}

function prePush(terms) {
  const commits = new Set();
  const checkedTags = new Set();
  const remote = process.argv[3];
  // A URL or an unnamed destination may have no tracking namespace: exclude
  // nothing in that case, rather than trusting history on unrelated remotes.
  const remoteRefs = remote ? git('for-each-ref', '--format=%(refname)', 'refs/remotes/').trim().split('\n')
    .filter(ref => ref.startsWith(`refs/remotes/${remote}/`)) : [];
  const input = fs.readFileSync(0, 'utf8');
  for (const line of input.split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !fields[1].match(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) || !fields[3].match(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)) {
      throw new Error('Cannot parse push updates; retry using git push.');
    }
    const [, localId, destination, remoteId] = fields;
    checkLine(terms, 'destination ref', 1, destination);
    if (/^0+$/.test(localId)) continue; // Ref deletion introduces no commits.
    if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
      throw new Error('Shallow history cannot be verified; git fetch --unshallow, then retry.');
    }
    checkTagMessages(localId, terms, checkedTags);
    context = '';
    const tip = git('rev-parse', '--verify', `${localId}^{commit}`).trim();
    // Existing refs: inspect everything absent from their advertised old tip.
    // New refs: exclude only this destination remote's tracked history.
    const range = /^0+$/.test(remoteId)
      ? [tip, '--not', ...remoteRefs]
      : [tip, '--not', git('rev-parse', '--verify', `${remoteId}^{commit}`).trim()];
    for (const commit of git('rev-list', ...range).trim().split('\n').filter(Boolean)) commits.add(commit);
  }
  for (const commit of commits) {
    context = ` (${commit.slice(0, 12)})`;
    const [author, committer] = git('show', '-s', '--format=%ae%x00%ce', commit).trim().split('\0');
    if (author !== EMAIL || committer !== EMAIL) {
      reject(`author/committer email must be ${EMAIL}; rewrite this commit with the correct identities.`);
    }
    const [headers, message] = objectParts('commit', commit);
    for (const label of ['author', 'committer']) {
      const ident = new RegExp(`^${label} (.*)$`, 'm').exec(headers);
      if (!ident) throw new Error('Cannot inspect commit identity; recreate the commit and retry.');
      checkIdentity(terms, label, ident[1]);
    }
    checkText(terms, 'commit message', message);
    const [, parent] = git('rev-list', '--parents', '-n', '1', commit).trim().split(' ');
    // First-parent diffs include merge resolutions; rev-list also visits side branches.
    const range = parent ? [parent, commit] : ['--root', commit];
    checkFiles(git('diff-tree', '--no-commit-id', '-r', ...RAW, ...range), terms);
  }
}

try {
  const terms = loadTerms();
  if (process.argv[2] === 'pre-commit') preCommit(terms);
  else if (process.argv[2] === 'commit-msg') commitMsg(terms);
  else if (process.argv[2] === 'pre-push') prePush(terms);
  else throw new Error('Run this guard through the installed Git hooks.');
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  reject(error.message);
  process.exitCode = 1;
}
