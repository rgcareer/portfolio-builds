import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';

// Guarded tarball extractor. The mirror step downloads content from potentially hostile
// repos, so extraction is an attack surface even though M1 never EXECUTES anything. This is
// a hand-written tar parser so every guard is explicit and owned (sop-mcp philosophy: unsafe
// states are structurally unreachable, not string-filtered after the fact):
//   - path traversal ('..'), absolute paths, and out-of-dest escapes are refused
//   - symlinks/hardlinks and all non-regular entries are skipped, never created
//   - the gunzip is hard-capped by maxOutputLength BEFORE parsing (bounds decompression bombs);
//     the per-file/per-repo/count caps then bound what is written to disk
// The mirror is DATA: never `npm install`ed, never executed.

export const DEFAULT_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxRepoBytes: 50 * 1024 * 1024,
  maxFiles: 2000,
  // Hard ceiling on the DECOMPRESSED tar size — well above any legitimate skill repo, but it
  // stops a small gzip from inflating to multi-GB and OOMing the harvester.
  maxDecompressedBytes: 256 * 1024 * 1024,
};

export interface TarEntry {
  name: string;
  typeflag: string; // '0' regular, '5' dir, '2' symlink, '1' hardlink, ...
  size: number;
  data: Buffer;
}

function readString(buf: Buffer, offset: number, len: number): string {
  const slice = buf.subarray(offset, offset + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

function parseOctal(buf: Buffer, offset: number, len: number): number {
  const s = readString(buf, offset, len).trim();
  return s === '' ? 0 : parseInt(s, 8) || 0;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

function parsePaxPath(data: Buffer): string | null {
  // pax records: "<len> key=value\n"
  const text = data.toString('utf8');
  const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
  return m ? m[1]! : null;
}

/** Parse a (decompressed) tar buffer into entries. Pure — no filesystem. */
export function iterateTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;

    const size = parseOctal(header, 124, 12);
    const rawType = header[156] ?? 0;
    const typeflag = rawType === 0 ? '0' : String.fromCharCode(rawType);
    let name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;

    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {
      longName = readString(data, 0, data.length).replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x') {
      paxPath = parsePaxPath(data);
      continue;
    }
    if (typeflag === 'g') continue;

    const finalName = paxPath ?? longName ?? name;
    longName = null;
    paxPath = null;
    entries.push({ name: finalName, typeflag, size, data: Buffer.from(data) });
  }
  return entries;
}

/** Strip the single top-level directory GitHub wraps a tarball in (owner-repo-sha/). */
export function stripTopDir(name: string): string {
  const i = name.indexOf('/');
  return i < 0 ? '' : name.slice(i + 1);
}

export function isUnsafeRelPath(rel: string): boolean {
  if (rel === '' || rel.startsWith('/')) return true;
  return rel.split('/').some((seg) => seg === '..' || seg === '');
}

function isWithin(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

export interface ExtractResult {
  fileCount: number;
  totalBytes: number;
  paths: string[];
  skipped: { path: string; reason: string }[];
}

export interface ExtractLimits {
  maxFileBytes: number;
  maxRepoBytes: number;
  maxFiles: number;
  maxDecompressedBytes: number;
}

/** Extract a gzipped tarball into destDir under strict guards. Returns extraction stats. */
export function extractTarballGz(
  gz: Buffer,
  destDir: string,
  limits: ExtractLimits = DEFAULT_LIMITS,
): ExtractResult {
  const result: ExtractResult = { fileCount: 0, totalBytes: 0, paths: [], skipped: [] };
  let tar: Buffer;
  try {
    // maxOutputLength bounds the decompression BEFORE we ever parse — a gzip bomb throws
    // here (RangeError) instead of inflating into memory.
    tar = gunzipSync(gz, { maxOutputLength: limits.maxDecompressedBytes });
  } catch (e) {
    result.skipped.push({ path: '(archive)', reason: `gunzip-failed:${(e as Error).message.slice(0, 60)}` });
    return result;
  }
  const entries = iterateTar(tar);

  for (const e of entries) {
    if (e.typeflag === '5') continue; // directory
    if (e.typeflag === '1' || e.typeflag === '2') {
      result.skipped.push({ path: e.name, reason: 'link-not-extracted' });
      continue;
    }
    if (e.typeflag !== '0') {
      result.skipped.push({ path: e.name, reason: `non-regular:${e.typeflag}` });
      continue;
    }

    const rel = stripTopDir(e.name);
    if (isUnsafeRelPath(rel)) {
      result.skipped.push({ path: e.name, reason: 'unsafe-path' });
      continue;
    }
    if (e.size > limits.maxFileBytes) {
      result.skipped.push({ path: rel, reason: 'file-too-large' });
      continue;
    }
    if (result.fileCount >= limits.maxFiles) {
      result.skipped.push({ path: rel, reason: 'file-count-cap' });
      continue;
    }
    if (result.totalBytes + e.size > limits.maxRepoBytes) {
      result.skipped.push({ path: rel, reason: 'repo-size-cap' });
      break;
    }

    const abs = join(destDir, rel);
    if (!isWithin(destDir, abs)) {
      result.skipped.push({ path: rel, reason: 'escapes-dest' });
      continue;
    }

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, e.data);
    result.totalBytes += e.size;
    result.fileCount++;
    result.paths.push(rel);
  }

  return result;
}
