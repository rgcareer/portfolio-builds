import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { iterateTar, extractTarballGz, stripTopDir, isUnsafeRelPath, DEFAULT_LIMITS } from '../src/mirror';
import { tarFile, tarArchive, gzTar } from './helpers';

describe('tar parsing + path guards', () => {
  it('strips the top-level dir and classifies paths', () => {
    expect(stripTopDir('repo-abc123/skills/a/SKILL.md')).toBe('skills/a/SKILL.md');
    expect(isUnsafeRelPath('../evil')).toBe(true);
    expect(isUnsafeRelPath('/etc/passwd')).toBe(true);
    expect(isUnsafeRelPath('a/../b')).toBe(true);
    expect(isUnsafeRelPath('a/b/c')).toBe(false);
  });

  it('iterateTar reads regular entries', () => {
    const tar = tarArchive([tarFile('r/a.txt', 'hello'), tarFile('r/b.md', 'world')]);
    const entries = iterateTar(tar).filter((e) => e.typeflag === '0');
    expect(entries.map((e) => e.name)).toEqual(['r/a.txt', 'r/b.md']);
    expect(entries[0]!.data.toString()).toBe('hello');
  });
});

describe('extractTarballGz guards', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skillcheck-mirror-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('extracts regular files, stripping the top dir', () => {
    const gz = gzTar([tarFile('repo-sha/SKILL.md', '---\nname: x\n---\n'), tarFile('repo-sha/a/b.txt', 'hi')]);
    const r = extractTarballGz(gz, dir);
    expect(r.paths.sort()).toEqual(['SKILL.md', 'a/b.txt']);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('name: x');
  });

  it('refuses path traversal', () => {
    const gz = gzTar([tarFile('repo-sha/../evil.txt', 'pwned'), tarFile('repo-sha/ok.txt', 'ok')]);
    const r = extractTarballGz(gz, dir);
    expect(r.paths).toEqual(['ok.txt']);
    expect(r.skipped.some((s) => s.reason === 'unsafe-path')).toBe(true);
    expect(existsSync(join(dir, '..', 'evil.txt'))).toBe(false);
  });

  it('never creates symlinks or hardlinks', () => {
    const gz = gzTar([tarFile('repo-sha/link', '', '2', '/etc/passwd'), tarFile('repo-sha/real.txt', 'x')]);
    const r = extractTarballGz(gz, dir);
    expect(r.paths).toEqual(['real.txt']);
    expect(r.skipped.some((s) => s.reason === 'link-not-extracted')).toBe(true);
    expect(existsSync(join(dir, 'link'))).toBe(false);
  });

  it('enforces the per-file size cap', () => {
    const gz = gzTar([tarFile('repo-sha/big.bin', 'x'.repeat(100)), tarFile('repo-sha/small.txt', 'ok')]);
    const r = extractTarballGz(gz, dir, { ...DEFAULT_LIMITS, maxFileBytes: 10 });
    expect(r.paths).toEqual(['small.txt']);
    expect(r.skipped.some((s) => s.reason === 'file-too-large')).toBe(true);
  });

  it('enforces the file-count cap', () => {
    const files = Array.from({ length: 5 }, (_, i) => tarFile(`repo-sha/f${i}.txt`, 'x'));
    const r = extractTarballGz(gzTar(files), dir, { ...DEFAULT_LIMITS, maxFiles: 3 });
    expect(r.fileCount).toBe(3);
    expect(r.skipped.some((s) => s.reason === 'file-count-cap')).toBe(true);
  });

  it('refuses a decompression bomb via the output-length cap (nothing written)', () => {
    // A highly-compressible archive that inflates past a tiny decompressed cap.
    const gz = gzTar([tarFile('repo-sha/big.txt', 'x'.repeat(20_000))]);
    const r = extractTarballGz(gz, dir, { ...DEFAULT_LIMITS, maxDecompressedBytes: 512 });
    expect(r.fileCount).toBe(0);
    expect(r.paths).toEqual([]);
    expect(r.skipped.some((s) => s.reason.startsWith('gunzip-failed'))).toBe(true);
  });
});
