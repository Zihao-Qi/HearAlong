// Trusted worker: no commands, managed-tool helpers, configuration discovery or network access.
// Only the metadata-bounded manifest authorized by read-scope.ts may be opened.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { Minimatch } = require('minimatch');
const { name, input, entries, maxBytes, maxLineChars } = workerData;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const identity = info => `${info.dev}:${info.ino}`;

function checked(entry) {
  if (fs.realpathSync.native(entry.path) !== entry.path) throw new Error('Search path changed after authorization');
  const info = fs.lstatSync(entry.path, { bigint: true });
  if (info.isSymbolicLink() || identity(info) !== entry.identity || info.isDirectory() !== entry.directory || (info.isFile() && info.nlink > 1n)) {
    throw new Error('Search path changed after authorization');
  }
  return info;
}
function open(entry) {
  if (!checked(entry).isFile()) return undefined;
  const fd = fs.openSync(entry.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd, { bigint: true });
    if (!info.isFile() || info.nlink > 1n || identity(info) !== entry.identity) throw new Error('Search path changed after authorization');
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
function binary(fd) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0, count;
  while ((count = fs.readSync(fd, buffer, 0, buffer.length, position))) {
    if (buffer.subarray(0, count).includes(0)) return true;
    position += count;
  }
  return false;
}
// Unlike readline, this bounds an unterminated line before decoding/allocating its full string.
function* lines(fd, position = 0, number = 1) {
  let parts = [], length = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const count = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (!count) break;
    let start = 0;
    for (let i = 0; i < count; i++) {
      if (buffer[i] !== 10) continue;
      const part = buffer.subarray(start, i);
      length += part.length;
      if (length > MAX_LINE_BYTES) throw new Error('Search line exceeds 8 MiB; search a smaller text file or use read with an offset/limit');
      parts.push(part);
      const text = Buffer.concat(parts, length).toString('utf8').replace(/\r$/, '');
      yield { text, number: number++, end: position + i + 1 };
      parts = []; length = 0; start = i + 1;
    }
    const part = buffer.subarray(start, count);
    length += part.length;
    if (length > MAX_LINE_BYTES) throw new Error('Search line exceeds 8 MiB; search a smaller text file or use read with an offset/limit');
    if (part.length) parts.push(part);
    position += count;
  }
  if (length) yield { text: Buffer.concat(parts, length).toString('utf8').replace(/\r$/, ''), number, end: position };
}
function natural(value, fallback, minimum) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error('Search context and limit must be finite numbers');
  return Math.max(minimum, Math.floor(value));
}
function glob(pattern, nocase = false) {
  return new Minimatch(pattern, { dot: true, nocase, nonegate: true, nocomment: true, noext: true, optimizationLevel: 2 });
}
function run() {
  if (!entries.length) throw new Error(`Path not found: ${input.path || '.'}`);
  const root = entries[0], directory = root.directory;
  const limit = natural(input.limit, name === 'grep' ? 100 : 1000, 1);
  const context = natural(input.context, 0, 0);
  let count = 0, bytes = 0, full = false, linesTruncated = false;
  const rows = [], searchFiles = [];
  const skippedFiles = { unreadable: 0, nonRegular: 0, unsafePath: 0 };
  const append = row => {
    if (full) return;
    bytes += Buffer.byteLength(row) + (rows.length ? 1 : 0);
    rows.push(row); // Keep one overflowing row for Pi's own whole-line byte truncation and details.
    full = bytes > maxBytes;
  };
  const compact = text => {
    const clean = text.replace(/\r/g, '');
    const cut = clean.length > maxLineChars;
    // V8 sliced strings can retain a multi-MiB source line. Copy the small UTF-16 prefix for the context ring.
    const prefix = cut ? Buffer.from(clean.slice(0, maxLineChars), 'utf16le').toString('utf16le') : clean;
    return { text: prefix, cut };
  };
  const short = item => {
    const clipped = item.cut ? item : compact(item.text);
    if (clipped.cut) linesTruncated = true;
    return clipped.text + (clipped.cut ? '... [truncated]' : '');
  };
  let matcher, fileGlob;
  if (name === 'grep') {
    // All regex evaluation happens in this terminable, memory-limited worker.
    matcher = input.literal ? null : new RegExp(input.pattern, input.ignoreCase ? 'iu' : 'u');
    if (input.glob) fileGlob = glob(input.glob.startsWith('!') ? input.glob.slice(1) : input.glob);
  } else {
    if (!directory) throw new Error(`Not a directory: ${root.path}`);
    let pattern = input.pattern;
    if (pattern.includes('/') && !pattern.startsWith('/') && !pattern.startsWith('**/')) pattern = `**/${pattern}`;
    // fd defaults to smart case; rg's --glob, above, is case-sensitive.
    fileGlob = glob(pattern, !/\p{Lu}/u.test(input.pattern));
  }
  const literal = input.ignoreCase ? input.pattern.toLocaleLowerCase('en-US') : input.pattern;
  for (const entry of entries) {
    if (full || count >= limit) break;
    const rel = directory ? path.relative(root.path, entry.path).split(path.sep).join('/') : path.basename(entry.path);
    // Keep the line protocol unambiguous, including C1 controls and Unicode line/paragraph separators.
    if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(entry.path)) { skippedFiles.unsafePath++; continue; }
    if (name === 'find') {
      if (!rel) continue; // fd returns descendants, not the search directory itself.
      checked(entry);
      const candidate = input.pattern.startsWith('/') ? entry.path : input.pattern.includes('/') ? rel : path.basename(entry.path);
      if (!fileGlob.match(candidate)) continue;
      append(rel + (entry.directory ? '/' : '')); count++;
      continue;
    }
    if (entry.directory) continue;
    if (fileGlob) {
      const pattern = input.glob.startsWith('!') ? input.glob.slice(1) : input.glob;
      const match = fileGlob.match(pattern.includes('/') ? rel : path.basename(entry.path));
      if (input.glob.startsWith('!') ? match : !match) continue;
    }
    const saved = { count, bytes, full, linesTruncated, rows: rows.length };
    let fd;
    try {
      fd = open(entry);
      if (fd === undefined) { skippedFiles.nonRegular++; continue; }
      // Scan the entire file for NUL before emitting any text, even if a match precedes the NUL.
      if (binary(fd)) continue;
      let history = [], historyStart = 0, historyBytes = 0;
      for (const line of lines(fd)) {
        const matches = matcher ? matcher.test(line.text) : (input.ignoreCase ? line.text.toLocaleLowerCase('en-US') : line.text).includes(literal);
        if (matches) {
          count++;
          const start = Math.max(1, line.number - context);
          const emit = item => { if (!full) append(`${rel}${item.number === line.number ? `:${item.number}: ` : `-${item.number}- `}${short(item)}`); };
          if (context && start < line.number) {
            if (history.length > historyStart && history[historyStart].number <= start) {
              for (let i = historyStart; i < history.length && !full; i++) if (history[i].number >= start) emit(history[i]);
            } else {
              // Huge context requests do not grow the ring: rescan only until the output budget is full.
              for (const item of lines(fd)) {
                if (item.number >= line.number || full) break;
                if (item.number >= start) emit(item);
              }
            }
          }
          emit(line);
          if (context && !full) for (const item of lines(fd, line.end, line.number + 1)) {
            if (item.number > line.number + context || full) break;
            emit(item);
          }
          if (full || count >= limit) break;
        }
        if (context) {
          const item = { ...compact(line.text), number: line.number };
          history.push(item); historyBytes += Buffer.byteLength(item.text) + 1;
          while (history.length - historyStart > context || historyBytes > maxBytes) historyBytes -= Buffer.byteLength(history[historyStart++].text) + 1;
          if (historyStart > 1024) { history = history.slice(historyStart); historyStart = 0; }
        }
      }
      if (rows.length > saved.rows) searchFiles.push(entry);
    } catch (error) {
      // Authorization mismatches and explicit resource/regex errors stay fatal. Ordinary file I/O failures do not.
      if (error.code === 'ELOOP') throw new Error('Search path changed after authorization');
      if (typeof error.code !== 'string') throw error;
      count = saved.count; bytes = saved.bytes; full = saved.full; linesTruncated = saved.linesTruncated; rows.length = saved.rows;
      skippedFiles.unreadable++;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return { skippedFiles, searchFiles, text: rows.length ? rows.join('\n') : name === 'grep' ? 'No matches found' : 'No files found matching pattern',
    ...(count >= limit ? { limitReached: limit } : {}), ...(linesTruncated && rows.length ? { linesTruncated: true } : {}) };
}
try { parentPort.postMessage({ output: run() }); }
catch (error) { parentPort.postMessage({ error: error.message }); }
