// The forge's whole state: repositories, git objects, refs, issues, pull requests, labels.
// Everything lives in memory (one process per trial). The viewer is the scenario's fixed token
// owner: the suite's scenario is deterministic from a fixed seed, so the login is always
// "adaiversen" (wire.ts SCENARIO_SEED; the token itself cannot yield a login).

import { ZERO_OID, hashObject, tickIso, tickSec } from './util.ts';

/** The token owner's identity, as the suite's scenario fixes it. */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** A git object type. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One git object: its type and its raw bytes. */
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** A label, as stored on a repository. */
export interface Label {
  id: number;
  name: string;
  color: string;
}

/** A comment on an issue. */
export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** An issue. */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

/** A pull request. headSha/baseSha are the branch tips snapshotted at creation. */
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** A repository: its git store plus its issues, pulls and labels. */
export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
}

/** The whole forge: every repository, keyed `owner/name` (lowercased), plus id counters. */
export class Store {
  repos = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextLabelId = 1;
  nextCommentId = 1;

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  getRepoById(id: number): Repo | null {
    return this.reposById.get(id) ?? null;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.getRepo(owner, name) !== null) return null;
    const now = tickIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (repo === null) return false;
    this.repos.delete(this.key(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  /** Every repository owned by `owner`, in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    return out;
  }

  /** The next shared issue/pull-request number for a repository. */
  nextNumber(repo: Repo): number {
    const n = repo.nextNumber;
    repo.nextNumber += 1;
    return n;
  }
}

// ---------------------------------------------------------------- git objects

/** A parsed commit. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}

/** Parse a commit object's bytes. Returns null when the bytes are not a commit. */
export function parseCommit(data: Buffer): ParsedCommit | null {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(author);
      if (m !== null) timestamp = Number(m[1]);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '') return null;
  return { tree, parents, author, committer, timestamp, message };
}

/** Build a commit object's bytes. */
export function buildCommit(tree: string, parents: readonly string[], message: string, timestamp: number): Buffer {
  const identity = `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${identity}\ncommitter ${identity}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

/** A parsed tag object: what it points at. */
export function parseTagTarget(data: Buffer): { oid: string; type: string } | null {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  let oid = '';
  let type = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) oid = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return oid === '' ? null : { oid, type };
}

/** One tree entry. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const mode = data.subarray(pos, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Build a tree object's bytes from entries (sorted git's way: dirs compare as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Store an object in a repository (idempotent) and return its oid. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** A flat file map: path -> the blob (or submodule) at that path. */
export type FlatTree = Map<string, { mode: string; oid: string }>;

/** Flatten a tree (recursively) into path -> entry. Missing trees flatten to empty. */
export function flattenTree(repo: Repo, treeOid: string): FlatTree {
  const flat: FlatTree = new Map();
  const stack: Array<{ oid: string; prefix: string }> = [{ oid: treeOid, prefix: '' }];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const { oid, prefix } = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') continue;
    for (const entry of parseTree(obj.data)) {
      const path = `${prefix}${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') stack.push({ oid: entry.oid, prefix: `${path}/` });
      else flat.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return flat;
}

/** Build (and store) the tree objects for a flat file map; returns the root tree oid. */
export function buildTreeFromFlat(repo: Repo, flat: FlatTree): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree oid of a commit, or null when the commit is unknown. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data)?.tree ?? null;
}

/** The flat file map at a commit (empty when the commit is unknown). */
export function commitFlatTree(repo: Repo, commitOid: string): FlatTree {
  const tree = commitTree(repo, commitOid);
  return tree === null ? new Map() : flattenTree(repo, tree);
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from `tips`, following commits, tags, trees and blobs. */
export function collectReachable(repo: Repo, tips: readonly string[]): Set<string> {
  return collectReachableBounded(repo, tips, new Set());
}

/**
 * Every object reachable from `tips`, except that commits in `stopCommits` contribute themselves
 * and their trees but not their parents: a shallow client's boundary commits are held without
 * their history, so a deepen fetch must not treat that history as already held.
 */
export function collectReachableBounded(repo: Repo, tips: readonly string[], stopCommits: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ZERO_OID || found.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    found.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit !== null) {
        stack.push(commit.tree);
        if (!stopCommits.has(oid)) for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null) stack.push(target.oid);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
  return found;
}

/** Every commit reachable from `tips` (tags peeled), as a set. */
export function collectCommits(repo: Repo, tips: readonly string[]): Set<string> {
  const found = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ZERO_OID || found.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null) stack.push(target.oid);
      continue;
    }
    if (obj.type !== 'commit') continue;
    found.add(oid);
    const commit = parseCommit(obj.data);
    if (commit !== null) for (const parent of commit.parents) stack.push(parent);
  }
  return found;
}

/** Whether `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const visited = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null) stack.push(target.oid);
      continue;
    }
    if (obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** A merge base of two commits: the common ancestor closest to `a` (exact for linear histories). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfB = collectCommits(repo, [b]);
  const visited = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (ancestorsOfB.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit !== null) for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/**
 * Commits within `depth` steps of `tips` (depth 1 = the tips themselves), plus the boundary:
 * included commits whose parents fall outside the included set.
 */
export function commitsWithinDepth(repo: Repo, tips: readonly string[], depth: number): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const queue: Array<{ oid: string; d: number }> = [];
  for (const tip of tips) {
    const obj = repo.objects.get(tip);
    if (obj?.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null && target.type === 'commit') queue.push({ oid: target.oid, d: 1 });
    } else if (obj?.type === 'commit') queue.push({ oid: tip, d: 1 });
  }
  while (queue.length > 0) {
    const { oid, d } = queue.shift()!;
    if (included.has(oid)) continue;
    included.add(oid);
    if (d >= depth) continue;
    const obj = repo.objects.get(oid);
    if (obj?.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit !== null) for (const parent of commit.parents) queue.push({ oid: parent, d: d + 1 });
  }
  const boundary = new Set<string>();
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (obj?.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    for (const parent of commit.parents) if (!included.has(parent)) boundary.add(oid);
  }
  return { included, boundary };
}

/** All commits reachable from `tip`, newest first (by commit timestamp, then discovery order). */
export function listCommits(repo: Repo, tip: string, limit: number): string[] {
  const commits = collectCommits(repo, [tip]);
  const withTime: Array<{ oid: string; time: number; order: number }> = [];
  let order = 0;
  // Discovery order: breadth-first from the tip, so ties resolve tip-first.
  const queue = [tip];
  const seen = new Set<string>();
  const discovery = new Map<string, number>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (!commits.has(oid)) continue;
    discovery.set(oid, order++);
    const obj = repo.objects.get(oid);
    if (obj?.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit !== null) for (const parent of commit.parents) queue.push(parent);
  }
  for (const oid of commits) {
    const obj = repo.objects.get(oid);
    const commit = obj?.type === 'commit' ? parseCommit(obj.data) : null;
    withTime.push({ oid, time: commit?.timestamp ?? 0, order: discovery.get(oid) ?? 0 });
  }
  withTime.sort((a, b) => b.time - a.time || a.order - b.order);
  return withTime.slice(0, limit).map((entry) => entry.oid);
}

// ---------------------------------------------------------------- diffs and merges

/** One changed file between two trees. */
export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Count the lines in a blob (a trailing newline does not add an empty line). */
function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

/** Line additions/deletions between two blobs, by multiset line difference. */
function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null && newData === null) return { additions: 0, deletions: 0 };
  if (oldData === null) return { additions: countLines(newData!), deletions: 0 };
  if (newData === null) return { additions: 0, deletions: countLines(oldData) };
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const have = oldCounts.get(line) ?? 0;
    if (have > 0) oldCounts.set(line, have - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

/** The file changes between two flat trees, sorted by filename. */
export function diffFlatTrees(repo: Repo, oldFlat: FlatTree, newFlat: FlatTree): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...oldFlat.keys(), ...newFlat.keys()]);
  for (const path of paths) {
    const oldEntry = oldFlat.get(path);
    const newEntry = newFlat.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const oldData = oldEntry === undefined ? null : (repo.objects.get(oldEntry.oid)?.data ?? null);
    const newData = newEntry === undefined ? null : (repo.objects.get(newEntry.oid)?.data ?? null);
    const { additions, deletions } = lineDiff(oldData, newData);
    const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
    changes.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  changes.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return changes;
}

/** The files a pull request changes: base tip tree vs head tip tree (current tips). */
export function pullRequestFiles(repo: Repo, pull: Pull): FileChange[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  return diffFlatTrees(repo, commitFlatTree(repo, baseTip), commitFlatTree(repo, headTip));
}

/** Whether a pull request can merge cleanly (three-way, against the merge base). */
export function pullRequestConflict(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return true;
  const baseFlat = commitFlatTree(repo, base);
  const baseTipFlat = commitFlatTree(repo, baseTip);
  const headFlat = commitFlatTree(repo, headTip);
  const paths = new Set<string>([...baseFlat.keys(), ...baseTipFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const atBase = baseFlat.get(path)?.oid;
    const atBaseTip = baseTipFlat.get(path)?.oid;
    const atHead = headFlat.get(path)?.oid;
    const baseChanged = atBaseTip !== atBase;
    const headChanged = atHead !== atBase;
    if (baseChanged && headChanged && atBaseTip !== atHead) return true;
  }
  return false;
}

/**
 * Squash-merge a pull request onto its base branch: one commit on the base tip carrying the head's
 * content. Returns the merge commit sha, or null when the merge conflicts.
 */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  void store;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return null;
  const baseFlat = commitFlatTree(repo, base);
  const baseTipFlat = commitFlatTree(repo, baseTip);
  const headFlat = commitFlatTree(repo, headTip);
  const merged: FlatTree = new Map(baseTipFlat);
  const paths = new Set<string>([...baseFlat.keys(), ...baseTipFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const atBase = baseFlat.get(path)?.oid;
    const atBaseTip = baseTipFlat.get(path)?.oid;
    const atHead = headFlat.get(path)?.oid;
    const baseChanged = atBaseTip !== atBase;
    const headChanged = atHead !== atBase;
    if (baseChanged && headChanged && atBaseTip !== atHead) return null;
    if (headChanged) {
      if (atHead === undefined) merged.delete(path);
      else merged.set(path, headFlat.get(path)!);
    }
  }
  const tree = buildTreeFromFlat(repo, merged);
  const message = `${pull.title} (#${pull.number})\n`;
  const commit = putObject(repo, 'commit', buildCommit(tree, baseTip === ZERO_OID ? [] : [baseTip], message, tickSec()));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  return commit;
}

// ---------------------------------------------------------------- contents commits

/** Split a repo-relative path into segments; null when it escapes the root. */
export function splitRepoPath(path: string): string[] | null {
  const parts = path.split('/').filter((part) => part !== '');
  for (const part of parts) if (part === '.' || part === '..') return null;
  return parts.length === 0 ? null : parts;
}

/**
 * Commit one file change on a branch (create, update, or delete when `content` is null).
 * A branch that does not exist yet starts from the default branch's tip. Returns the commit and
 * blob shas, or an error kind: 'not-found' (delete of a missing file), 'stale' (sha mismatch).
 */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
  expectedSha?: string,
): { commitSha: string; blobSha: string | null } | { error: 'not-found' | 'stale' } {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const flat = tip === undefined ? new Map<string, { mode: string; oid: string }>() : commitFlatTree(repo, tip);
  const current = flat.get(path);
  if (content === null) {
    if (current === undefined) return { error: 'not-found' };
    if (expectedSha !== undefined && current.oid.toLowerCase() !== expectedSha.toLowerCase()) return { error: 'stale' };
    flat.delete(path);
  } else {
    if (current !== undefined && expectedSha !== undefined && current.oid.toLowerCase() !== expectedSha.toLowerCase()) {
      return { error: 'stale' };
    }
    const blobSha = putObject(repo, 'blob', content);
    flat.set(path, { mode: '100644', oid: blobSha });
  }
  const tree = buildTreeFromFlat(repo, flat);
  const parents = tip === undefined ? [] : [tip];
  const commitSha = putObject(repo, 'commit', buildCommit(tree, parents, message.endsWith('\n') ? message : `${message}\n`, tickSec()));
  repo.refs.set(ref, commitSha);
  const blobSha = content === null ? null : flat.get(path)?.oid ?? null;
  return { commitSha, blobSha };
}

// ---------------------------------------------------------------- global ids (Relay-style, opaque)

/** A repository's opaque global id. */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64');
}

/** An issue's opaque global id. */
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64');
}

/** A pull request's opaque global id. */
export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64');
}

/** A comment's opaque global id. */
export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64');
}

/** Decode an opaque global id into its kind and numeric parts, or null. */
export function decodeGlobalId(id: string): { kind: string; parts: number[] } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0]!;
  const nums: number[] = [];
  for (const part of parts.slice(1)) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  // Re-encode check: the id must be exactly the canonical base64 of its text.
  if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
  return { kind, parts: nums };
}
