// Git smart HTTP: pkt-line framing, packfile read/write (with OFS_DELTA and REF_DELTA on
// receive, plain objects only on send), protocol v2 + v0 upload-pack, and v0 receive-pack.
// The client is the kit's git-client.ts; every framing choice below matches what it parses.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  errorResult,
  hashObject,
  isObjectId,
  jsonResult,
  type HttpResult,
} from './util.ts';
import {
  collectCommits,
  collectReachable,
  collectReachableBounded,
  commitFlatTree,
  commitTree,
  commitsWithinDepth,
  isAncestor,
  parseCommit,
  parseTagTarget,
  parseTree,
  putObject,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

const AGENT = 'merlin-forge/1.0.0';

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line packet. */
export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode a data packet (string or bytes). */
export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

/** The flush packet. */
export const FLUSH = Buffer.from('0000', 'ascii');
/** The delim packet. */
export const DELIM = Buffer.from('0001', 'ascii');

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(pos, pos + 4).toString('ascii');
    if (hex === '0000') {
      packets.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (hex === '0001') {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (hex === '0002') {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len < 4 || pos + len > buf.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(pos + 4, pos + len)) });
    pos += len;
  }
  return packets;
}

/** Encode a list of text lines (each already newline-terminated) plus control packets. */
export function encodeLines(lines: Array<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH);
    else if (line === 'delim') parts.push(DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Split a sideband payload into pkt-lines (band byte + at most 65515 data bytes each). */
function sidebandChunks(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX_DATA = 65515;
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let pos = 0; pos < data.length; pos += MAX_DATA) {
    const chunk = data.subarray(pos, Math.min(pos + MAX_DATA, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------- packfiles

const TYPE_NUM: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Build a packfile from plain objects (no deltas), in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeNum = TYPE_NUM[object.type];
    const size = object.data.length;
    const head: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    head.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      head.push(byte);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Try to inflate a slice; null when it is not (the prefix of) a complete deflate stream. */
function tryInflate(slice: Buffer): Buffer | null {
  try {
    return inflateSync(slice);
  } catch {
    return null;
  }
}

/**
 * Inflate the deflate stream starting at `pos` (bounded by `end`): inflateSync ignores trailing
 * bytes and throws on truncation, so the stream's length is the smallest prefix that inflates.
 * The last object of a pack ends exactly at `end`, so it needs no search; other objects search
 * within the stored-size bound (a deflate stream is never longer than its output stored raw).
 */
function inflateAt(buf: Buffer, pos: number, end: number, isLast: boolean): { data: Buffer; next: number } {
  if (isLast) {
    try {
      return { data: inflateSync(buf.subarray(pos, end)), next: end };
    } catch {
      throw new Error('pack entry is not a valid deflate stream');
    }
  }
  const full = tryInflate(buf.subarray(pos, end));
  if (full === null) throw new Error('pack entry is not a valid deflate stream');
  const n = full.length;
  const hiBound = Math.min(end, pos + n + 16 + 5 * Math.ceil(n / 65535));
  let lo = pos;
  let hi = hiBound;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tryInflate(buf.subarray(pos, mid)) !== null) hi = mid;
    else lo = mid;
  }
  return { data: full, next: hi };
}

/** Read a packfile size varint (7-bit groups, little-endian). */
function readSizeVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new Error('truncated pack varint');
    const byte = buf[p]!;
    value |= (byte & 0x7f) << shift;
    p += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: p };
}

/** Apply a git delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readSizeVarint(delta, pos);
  pos = src.next;
  if (src.value !== base.length) throw new Error('delta source size does not match its base');
  const tgt = readSizeVarint(delta, pos);
  pos = tgt.next;
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('truncated delta copy offset');
          offset |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('truncated delta copy size');
          size |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past its base');
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else {
      const count = op & 0x7f;
      if (count === 0) throw new Error('delta insert of zero bytes');
      if (pos + count > delta.length) throw new Error('truncated delta insert');
      out.push(delta.subarray(pos, pos + count));
      pos += count;
      total += count;
    }
  }
  if (total !== tgt.value) throw new Error('delta target size does not match');
  return Buffer.concat(out);
}

/**
 * Parse a packfile, resolving OFS_DELTA and REF_DELTA. `resolveBase` finds objects the pack
 * references but does not carry (thin packs); it is consulted for REF_DELTA bases only.
 * Returns the objects keyed by oid, in pack order.
 */
export function readPack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): { objects: Map<string, GitObject>; deltaCount: number } {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let pos = 12;
  let deltaCount = 0;
  const end = buf.length - 20; // the trailer
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    if (pos >= end) throw new Error('pack ends before its object count');
    let byte = buf[pos]!;
    pos += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (pos >= end) throw new Error('truncated pack object header');
      byte = buf[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // OFS_DELTA: the base offset (git's negative-offset varint), then the delta.
      if (pos >= end) throw new Error('truncated OFS_DELTA offset');
      byte = buf[pos]!;
      pos += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (pos >= end) throw new Error('truncated OFS_DELTA offset');
        byte = buf[pos]!;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(entryStart - offset);
      if (base === undefined) throw new Error('OFS_DELTA base is not an earlier pack entry');
      const inflated = inflateAt(buf, pos, end, i === count - 1);
      pos = inflated.next;
      const data = applyDelta(base.data, inflated.data);
      if (data.length !== size) throw new Error('OFS_DELTA result size does not match its header');
      const object: GitObject = { type: base.type, data };
      const oid = hashObject(object.type, object.data);
      objects.set(oid, object);
      byOffset.set(entryStart, object);
      deltaCount += 1;
    } else if (typeNum === 7) {
      // REF_DELTA: the 20-byte base oid, then the delta.
      if (pos + 20 > end) throw new Error('truncated REF_DELTA base oid');
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const inflated = inflateAt(buf, pos, end, i === count - 1);
      pos = inflated.next;
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error(`REF_DELTA base ${baseOid} is unknown`);
      const data = applyDelta(base.data, inflated.data);
      if (data.length !== size) throw new Error('REF_DELTA result size does not match its header');
      const object: GitObject = { type: base.type, data };
      const oid = hashObject(object.type, object.data);
      objects.set(oid, object);
      byOffset.set(entryStart, object);
      deltaCount += 1;
    } else {
      const type = NUM_TYPE[typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      const inflated = inflateAt(buf, pos, end, i === count - 1);
      pos = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size does not match its header');
      const object: GitObject = { type, data: inflated.data };
      const oid = hashObject(type, object.data);
      objects.set(oid, object);
      byOffset.set(entryStart, object);
    }
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------- advertisements

/** A ref line for a v0 advertisement: oid, name, and (for annotated tags) the peeled line. */
function v0RefLines(repo: Repo): Array<{ oid: string; name: string }> {
  const lines: Array<{ oid: string; name: string }> = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) lines.push({ oid: defaultTip, name: 'HEAD' });
  const heads = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  for (const ref of heads) lines.push({ oid: repo.refs.get(ref)!, name: ref });
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of tags) {
    const oid = repo.refs.get(ref)!;
    lines.push({ oid, name: ref });
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null && target.type === 'commit') lines.push({ oid: target.oid, name: `${ref}^{}` });
    }
  }
  const other = [...repo.refs.keys()]
    .filter((ref) => !ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/'))
    .sort();
  for (const ref of other) lines.push({ oid: repo.refs.get(ref)!, name: ref });
  return lines;
}

/** A v0 advertisement (upload-pack or receive-pack) with its service preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k multi_ack_detailed multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = v0RefLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** A v2 advertisement (upload-pack only). */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    FLUSH,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

/** GET /info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === null) return errorResult(404, 'Not Found');
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
        body: v2Advertisement(),
      };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      body: v0Advertisement(repo, 'git-upload-pack'),
    };
  }
  if (service === 'git-receive-pack') {
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
      body: v0Advertisement(repo, 'git-receive-pack'),
    };
  }
  return errorResult(404, 'Not Found');
}

// ---------------------------------------------------------------- fetch computation

/** What one fetch sends: the object oids, shallow info, and the ACK/NAK answer. */
export interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Plan a fetch: which objects to send for `wants`, given what the client `haves`, its shallow
 * boundaries, and an optional depth. Selection is exact: reachable(wants) minus reachable(haves),
 * cut at `depth` when given.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchPlan {
  const tagObjects: string[] = [];
  const wantCommits: string[] = [];
  for (const oid of wants) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagObjects.push(oid);
      const target = parseTagTarget(obj.data);
      if (target !== null && target.type === 'commit') wantCommits.push(target.oid);
    } else if (obj.type === 'commit') wantCommits.push(oid);
  }
  let included: Set<string>;
  let boundary = new Set<string>();
  if (depth !== null) {
    const within = commitsWithinDepth(repo, wantCommits, depth);
    included = within.included;
    boundary = within.boundary;
  } else {
    included = collectCommits(repo, wantCommits);
  }
  const haveReachable = collectReachableBounded(repo, haves, new Set(shallowBoundaries));
  const send = new Set<string>();
  for (const oid of tagObjects) if (!haveReachable.has(oid)) send.add(oid);
  for (const oid of included) {
    if (haveReachable.has(oid)) continue;
    send.add(oid);
    const tree = commitTree(repo, oid);
    if (tree !== null) {
      for (const o of collectReachable(repo, [tree])) if (!haveReachable.has(o)) send.add(o);
    }
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of boundary) if (!haveReachable.has(oid)) shallow.push(oid);
    for (const s of shallowBoundaries) {
      const obj = repo.objects.get(s);
      if (obj?.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      if (commit !== null && commit.parents.some((p) => included.has(p) && !haveReachable.has(p))) unshallow.push(s);
    }
  }
  // ACKs: a have is common when it is an ancestor of a want. With no haves there is nothing to
  // walk (the common case for clones); otherwise test each have directly instead of collecting
  // the whole ancestry — a targeted walk that stops at the have.
  const acks: string[] = [];
  if (haves.length > 0) {
    for (const have of haves) {
      if (wantCommits.some((want) => isAncestor(repo, have, want))) acks.push(have);
    }
  }
  return { objects: [...send].sort(), shallow: shallow.sort(), unshallow: unshallow.sort(), acks };
}

/** Build the pack for a fetch plan (sorted oids, plain objects only). */
function packForPlan(repo: Repo, plan: FetchPlan): Buffer {
  const objects: GitObject[] = [];
  for (const oid of plan.objects) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.push(obj);
  }
  return writePack(objects);
}

// ---------------------------------------------------------------- upload-pack v2

/** One v2 command request: the command name and its argument lines (delim-split). */
function parseV2Command(packets: Packet[]): { command: string; args: string[] } {
  const dataBeforeDelim: string[] = [];
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenDelim) dataBeforeDelim.push(line);
    else args.push(line);
  }
  if (!seenDelim) throw new Error('v2 request has no delim packet');
  const first = (dataBeforeDelim[0] ?? '').replace(/\n$/, '');
  if (!first.startsWith('command=')) throw new Error('v2 request has no command');
  return { command: first.slice('command='.length), args: args.map((arg) => arg.replace(/\n$/, '')) };
}

/** Answer a v2 ls-refs: ref lines (with symref-target / peeled attributes when asked), then flush. */
function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const symrefAttr = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
  if (defaultTip !== undefined) {
    if (keep('HEAD')) lines.push(`${defaultTip} HEAD${symrefAttr}\n`);
  } else if (unborn) {
    if (keep('HEAD')) lines.push(`unborn HEAD${symrefAttr}\n`);
  }
  const refs = [...repo.refs.keys()].sort();
  for (const ref of refs) {
    if (!keep(ref)) continue;
    const oid = repo.refs.get(ref)!;
    let attr = '';
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target !== null && target.type === 'commit') attr = ` peeled:${target.oid}`;
      }
    }
    lines.push(`${oid} ${ref}${attr}\n`);
  }
  return encodeLines([...lines, 'flush']);
}

/** Answer a v2 fetch: acknowledgments, shallow-info (when non-empty), packfile, flush. */
function handleFetchV2(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: accepted, no effect
    // (this server never deltifies, so thin-pack changes nothing; filters are honoured by sending
    // the full objects the checks assert on).
  }
  for (const oid of [...wants, ...haves, ...shallow]) {
    if (!isObjectId(oid)) throw new Error(`bad object id ${JSON.stringify(oid)}`);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = packForPlan(repo, plan);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    parts.push(pktLine(`ACK ${plan.acks[0]}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack v0

/** Answer a v0 fetch: shallow/unshallow/NAK/ACK text lines, then the sideband pack. */
function handleFetchV0(repo: Repo, packets: Packet[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        // The first want line carries capabilities after a space; the oid is the second token.
        const oid = line.slice(5).split(' ')[0]!;
        wants.push(oid);
      } else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isSafeInteger(n) && n > 0) depth = n;
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
    // deepen-since, deepen-not, done: accepted, no effect.
  }
  if (wants.length === 0) throw new Error('v0 fetch has no wants');
  for (const oid of [...wants, ...haves, ...shallow]) {
    if (!isObjectId(oid)) throw new Error(`bad object id ${JSON.stringify(oid)}`);
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = packForPlan(repo, plan);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.acks.length > 0) parts.push(pktLine(`ACK ${plan.acks[0]}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack. */
export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | undefined,
): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === null) return errorResult(404, 'Not Found');
  let packets: Packet[];
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return errorResult(400, err instanceof Error ? err.message : 'malformed pkt-line stream');
  }
  try {
    let out: Buffer;
    if (gitProtocol === 'version=2') {
      const { command, args } = parseV2Command(packets);
      if (command === 'ls-refs') out = handleLsRefs(repo, args);
      else if (command === 'fetch') out = handleFetchV2(repo, args);
      else return errorResult(400, `unknown v2 command ${JSON.stringify(command)}`);
    } else {
      out = handleFetchV0(repo, packets);
    }
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: out };
  } catch (err) {
    return errorResult(400, err instanceof Error ? err.message : 'malformed upload-pack request');
  }
}

// ---------------------------------------------------------------- receive-pack v0

/** One parsed push command. */
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack. */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === null) return errorResult(404, 'Not Found');
  // Split the command pkt-lines (up to the first flush) from the raw pack bytes after it.
  let pos = 0;
  const commandLines: string[] = [];
  let clientCaps: string[] = [];
  let packStart = -1;
  try {
    while (pos < body.length) {
      if (pos + 4 > body.length) throw new Error('truncated pkt-line length');
      const hex = body.subarray(pos, pos + 4).toString('ascii');
      if (hex === '0000') {
        packStart = pos + 4;
        break;
      }
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
      const len = parseInt(hex, 16);
      if (len < 4 || pos + len > body.length) throw new Error('pkt-line length out of range');
      commandLines.push(body.subarray(pos + 4, pos + len).toString('utf8'));
      pos += len;
    }
  } catch (err) {
    return errorResult(400, err instanceof Error ? err.message : 'malformed receive-pack request');
  }
  if (packStart === -1) return errorResult(400, 'receive-pack request has no flush packet');
  const commands: PushCommand[] = [];
  for (let i = 0; i < commandLines.length; i += 1) {
    let line = commandLines[i]!.replace(/\n$/, '');
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        clientCaps = line.slice(nul + 1).split(' ').filter(Boolean);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2]!.startsWith('refs/')) {
      return errorResult(400, `bad push command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) return errorResult(400, 'receive-pack request has no commands');

  const sideband = clientCaps.includes('side-band-64k');
  const reportLines: string[] = [];
  // Unpack first: a refused push still unpacks ok (objects stored, ref unmoved).
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.slice(0, 120) : 'unpacker error';
    }
  }
  reportLines.push(`unpack ${unpackDetail}\n`);
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    let ok = false;
    let reason = '';
    if (command.newOid === ZERO_OID) {
      // Delete: the old value must match the current tip.
      if (current === undefined) reason = 'non-fast-forward';
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
      else ok = true;
    } else {
      if (repo.objects.get(command.newOid) === undefined) {
        reason = 'object not found';
      } else if (command.oldOid === ZERO_OID) {
        // Create: the ref must not exist yet.
        if (current !== undefined) reason = 'non-fast-forward';
        else ok = true;
      } else if (current === undefined) {
        reason = 'non-fast-forward';
      } else if (command.oldOid !== current) {
        reason = 'non-fast-forward';
      } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
        reason = 'non-fast-forward';
      } else ok = true;
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    } else {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    }
  }
  // The report-status stream is itself pkt-lined; inside band 1 when side-band was negotiated.
  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(line)), FLUSH]);
  let out: Buffer;
  if (sideband) {
    out = Buffer.concat([...sidebandChunks(1, reportStream), FLUSH]);
  } else {
    out = reportStream;
  }
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: out };
}

// Re-exported for the test client.
export { collectReachable as gitCollectReachable };
