import { gzipSync } from 'node:zlib';

// Minimal ustar tar builder for tests — lets us craft adversarial archives (path traversal,
// symlinks, oversize) that real `tar` refuses to produce.
export function tarHeader(name: string, size: number, typeflag = '0', linkname = ''): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100);
  buf.write('0000644\0', 100);
  buf.write('0000000\0', 108);
  buf.write('0000000\0', 116);
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124);
  buf.write('00000000000\0', 136);
  buf.write(typeflag, 156, 1);
  if (linkname) buf.write(linkname, 157, 100);
  buf.write('ustar\0', 257);
  buf.write('00', 263);
  for (let i = 148; i < 156; i++) buf[i] = 0x20; // checksum field = spaces
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i]!;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return buf;
}

export function tarFile(name: string, content = '', typeflag = '0', linkname = ''): Buffer {
  const data = Buffer.from(content);
  const size = typeflag === '2' ? 0 : data.length;
  const header = tarHeader(name, size, typeflag, linkname);
  if (typeflag === '2' || typeflag === '5') return header;
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}

export function tarArchive(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

export function gzTar(entries: Buffer[]): Buffer {
  return gzipSync(tarArchive(entries));
}

/** A minimal Response-like for mocking fetch. */
export function makeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  buffer?: Buffer;
}): Response {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(opts.headers ?? {}),
    text: async () => opts.body ?? '',
    json: async () => JSON.parse(opts.body ?? 'null'),
    arrayBuffer: async () => opts.buffer ?? Buffer.from(opts.body ?? ''),
  } as unknown as Response;
}
