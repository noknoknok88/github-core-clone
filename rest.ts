// GitHub REST v3 under /api/v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests, files and merges. Every reply is JSON (never HTML), carries
// X-GitHub-Request-Id (added by app.ts), and errors carry {message: <non-empty string>}.

import {
  VIEWER,
  commitFile,
  commitFlatTree,
  diffFlatTrees,
  listCommits,
  parseCommit,
  parseTagTarget,
  parseTree,
  pullRequestConflict,
  pullRequestFiles,
  splitRepoPath,
  squashMerge,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { b64decode, b64encode, errorResult, isObjectId, jsonResult, lower, tickIso, type HttpResult } from './util.ts';

// ---------------------------------------------------------------- shapes

/** The GitHub user object for the token owner. */
export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    avatar_url: '',
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: '', default: false };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  let mergeable: boolean | null = null;
  if (pull.state === 'open') {
    try {
      mergeable = !pullRequestConflict(repo, pull);
    } catch {
      mergeable = null;
    }
  }
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.state === 'open' ? (mergeable === true ? 'clean' : 'dirty') : 'unknown',
    merged_by: pull.merged ? { login: VIEWER.login, id: VIEWER.id, type: 'User' } : null,
    comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const commit = obj?.type === 'commit' ? parseCommit(obj.data) : null;
  const message = (commit?.message ?? '').replace(/\n$/, '');
  return {
    name,
    commit: {
      sha,
      commit: {
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: '' },
        committer: { name: VIEWER.name, email: VIEWER.email, date: '' },
      },
    },
    protected: false,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const commit = obj?.type === 'commit' ? parseCommit(obj.data) : null;
  const authorLine = commit?.author ?? '';
  const nameEmail = /^([^<]+)<([^>]+)>/.exec(authorLine);
  const name = nameEmail?.[1]?.trim() ?? VIEWER.name;
  const email = nameEmail?.[2] ?? VIEWER.email;
  const date = commit !== null && commit.timestamp > 0 ? new Date(commit.timestamp * 1000).toISOString() : '';
  const message = (commit?.message ?? '').replace(/\n$/, '');
  return {
    sha: oid,
    commit: {
      message,
      author: { name, email, date },
      committer: { name, email, date },
    },
    parents: (commit?.parents ?? []).map((sha) => ({ sha })),
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

// ---------------------------------------------------------------- helpers

/** A request's query parameters (already URL-decoded). */
export type Query = Map<string, string>;

/** Parse per_page/page with GitHub's defaults and clamps. */
function pagination(query: Query): { perPage: number; page: number } {
  let perPage = Number(query.get('per_page') ?? '30');
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  let page = Number(query.get('page') ?? '1');
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { perPage: Math.trunc(perPage), page: Math.trunc(page) };
}

/** A Link header for a paginated list (rel="next" and rel="last" when they exist). */
function linkHeader(host: string, path: string, query: Query, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const build = (p: number): string => {
    const params = new URLSearchParams();
    for (const [key, value] of query) if (key !== 'page') params.set(key, value);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `<http://${host}${path}?${params.toString()}>`;
  };
  if (page < totalPages) links.push(`${build(page + 1)}; rel="next"`);
  if (totalPages > 1) links.push(`${build(totalPages)}; rel="last"`);
  if (page > 1) links.push(`${build(1)}; rel="first"`);
  if (page > 1) links.push(`${build(page - 1)}; rel="prev"`);
  return links.length === 0 ? null : links.join(', ');
}

/** Slice a list for one page. */
function pageOf<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** A paginated JSON list answer. */
function listResult(host: string, path: string, query: Query, items: unknown[]): HttpResult {
  const { perPage, page } = pagination(query);
  const headers: Record<string, string> = {};
  const link = linkHeader(host, path, query, page, perPage, items.length);
  if (link !== null) headers.link = link;
  return jsonResult(200, pageOf(items, page, perPage), headers);
}

/** Resolve a repo for a request: the owner must be the token owner, and the repo must exist. */
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return null;
  return store.getRepo(owner, name);
}

/** Resolve a ref name (branch, tag, or oid) to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) {
    const obj = repo.objects.get(tag);
    if (obj?.type === 'tag') {
      const target = parseTagTarget(obj.data);
      return target !== null ? target.oid : tag;
    }
    return tag;
  }
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** Parse a JSON body; returns null for an empty body, or throws a 400-shaped error. */
function parseBody(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Problems parsing JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Problems parsing JSON');
  return value as Record<string, unknown>;
}

/** A string field of a body, or a default. */
function str(body: Record<string, unknown> | null, key: string, fallback = ''): string {
  const value = body?.[key];
  return typeof value === 'string' ? value : fallback;
}

/** Whether a body value is a JSON boolean. */
function bool(body: Record<string, unknown> | null, key: string, fallback = false): boolean {
  const value = body?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------- the router

/**
 * Handle one REST request. `segments` are the decoded path segments after /api/v3 (so GET
 * /api/v3/ is [] and GET /api/v3/meta is ['meta']); `path` is the raw /api/v3/... path for
 * Link headers. Auth was already checked by the caller except for the public root/meta routes.
 */
export function handleRest(
  store: Store,
  method: string,
  segments: readonly string[],
  query: Query,
  bodyText: string,
  host: string,
  path: string,
): HttpResult {
  // API root: 200 + the token's scopes.
  if (segments.length === 0) {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(
      200,
      {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/tokens',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: 'https://api.github.com/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
        notifications_url: '/api/v3/notifications',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_teams_url: '/api/v3/orgs/{org}/teams',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // Meta: 200 with a non-empty installed_version.
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /user: the token owner.
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    return jsonResult(200, userJson());
  }

  // /user/repos: list (paginated) / create.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      return listResult(host, path, query, store.listRepos(VIEWER.login).map(repoJson));
    }
    if (method === 'POST') {
      let body: Record<string, unknown> | null;
      try {
        body = parseBody(bodyText);
      } catch (err) {
        return errorResult(400, err instanceof Error ? err.message : 'Problems parsing JSON');
      }
      const name = str(body, 'name');
      if (name === '' || name.length > 100) return errorResult(422, 'Validation Failed: name is required');
      const repo = store.createRepo(VIEWER.login, name, bool(body, 'private', false), str(body, 'description'));
      if (repo === null) {
        return errorResult(422, 'Repository creation failed. (name already exists on this account)');
      }
      return jsonResult(201, repoJson(repo));
    }
    return errorResult(404, 'Not Found');
  }

  // Everything below addresses one repository.
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const repoName = segments[2]!;
    const repo = resolveRepo(store, owner, repoName);
    if (repo === null) return errorResult(404, 'Not Found');
    const rest = segments.slice(3);
    if (rest.length === 0) return handleRepo(store, repo, method, bodyText);
    if (rest[0] === 'branches') return handleBranches(repo, rest.slice(1), method);
    if (rest[0] === 'commits') return handleCommits(repo, rest.slice(1), method, query);
    if (rest[0] === 'git' && rest[1] === 'refs') return handleGitRefs(repo, rest.slice(2), method, bodyText);
    if (rest[0] === 'contents') return handleContents(repo, rest.slice(1), method, query, bodyText);
    if (rest[0] === 'labels') return handleLabels(store, repo, rest.slice(1), method, bodyText);
    if (rest[0] === 'issues') return handleIssues(store, repo, rest.slice(1), method, query, bodyText, host, path);
    if (rest[0] === 'pulls') return handlePulls(store, repo, rest.slice(1), method, query, bodyText, host, path);
    return errorResult(404, 'Not Found');
  }

  return errorResult(404, 'Not Found');
}

/** GET/PATCH/DELETE /repos/{owner}/{repo}. */
function handleRepo(store: Store, repo: Repo, method: string, bodyText: string): HttpResult {
  if (method === 'GET') return jsonResult(200, repoJson(repo));
  if (method === 'DELETE') {
    store.deleteRepo(repo.owner, repo.name);
    return { status: 204, body: '' };
  }
  if (method === 'PATCH') {
    let body: Record<string, unknown> | null;
    try {
      body = parseBody(bodyText);
    } catch (err) {
      return errorResult(400, err instanceof Error ? err.message : 'Problems parsing JSON');
    }
    if (body !== null) {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
        repo.defaultBranch = body.default_branch;
      }
      repo.updatedAt = tickIso();
    }
    return jsonResult(200, repoJson(repo));
  }
  return errorResult(404, 'Not Found');
}

/** GET /repos/{o}/{r}/branches[/{branch}]. */
function handleBranches(repo: Repo, rest: readonly string[], method: string): HttpResult {
  if (method !== 'GET') return errorResult(404, 'Not Found');
  if (rest.length === 0) {
    const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
    const branches = names.map((ref) => branchJson(repo, ref.slice('refs/heads/'.length), repo.refs.get(ref)!));
    return jsonResult(200, branches);
  }
  const name = rest.join('/');
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (sha === undefined) return errorResult(404, 'Branch not found');
  return jsonResult(200, branchJson(repo, name, sha));
}

/** GET /repos/{o}/{r}/commits[?sha=<ref>]. */
function handleCommits(repo: Repo, rest: readonly string[], method: string, query: Query): HttpResult {
  if (method !== 'GET' || rest.length !== 0) return errorResult(404, 'Not Found');
  const ref = query.get('sha');
  const tip = resolveRef(repo, ref);
  if (tip === null) {
    // An unborn repository has no commits; an unknown ref is a 404.
    if (ref === undefined || ref === '') return jsonResult(200, []);
    return errorResult(404, 'Not Found');
  }
  const { perPage, page } = pagination(query);
  const commits = listCommits(repo, tip, page * perPage + 1).slice((page - 1) * perPage, page * perPage);
  return jsonResult(200, commits.map((oid) => commitJson(repo, oid)));
}

/** POST/GET/DELETE /repos/{o}/{r}/git/refs[/...]. */
function handleGitRefs(repo: Repo, rest: readonly string[], method: string, bodyText: string): HttpResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const refs = [...repo.refs.keys()].sort().map((ref) => ({
        ref,
        object: { sha: repo.refs.get(ref), type: repo.objects.get(repo.refs.get(ref)!)?.type ?? 'commit' },
      }));
      return jsonResult(200, refs);
    }
    if (method === 'POST') {
      let body: Record<string, unknown> | null;
      try {
        body = parseBody(bodyText);
      } catch (err) {
        return errorResult(400, err instanceof Error ? err.message : 'Problems parsing JSON');
      }
      const ref = str(body, 'ref');
      const sha = lower(str(body, 'sha'));
      if (!ref.startsWith('refs/')) return errorResult(422, 'Validation Failed: ref must start with refs/');
      if (!isObjectId(sha) || !repo.objects.has(sha)) return errorResult(422, 'Validation Failed: object does not exist');
      if (repo.refs.has(ref)) return errorResult(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return jsonResult(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    return errorResult(404, 'Not Found');
  }
  const ref = `refs/${rest.join('/')}`;
  if (method === 'GET') {
    const sha = repo.refs.get(ref);
    if (sha === undefined) return errorResult(404, 'Not Found');
    return jsonResult(200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  }
  if (method === 'DELETE') {
    if (!repo.refs.has(ref)) return errorResult(404, 'Not Found');
    repo.refs.delete(ref);
    return { status: 204, body: '' };
  }
  return errorResult(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

/** Walk a tree to `parts`; returns the entry (file or dir) or null. */
function lookupPath(
  repo: Repo,
  treeOid: string,
  parts: readonly string[],
): { kind: 'file' | 'dir'; oid: string; mode: string } | null {
  let currentOid = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(currentOid);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    if (i === parts.length - 1) return { kind: isDir ? 'dir' : 'file', oid: entry.oid, mode: entry.mode };
    if (!isDir) return null;
    currentOid = entry.oid;
  }
  return null;
}

/** GET/PUT/DELETE /repos/{o}/{r}/contents/{path}. */
function handleContents(repo: Repo, rest: readonly string[], method: string, query: Query, bodyText: string): HttpResult {
  const path = rest.join('/');
  if (method === 'GET') {
    const tip = resolveRef(repo, query.get('ref'));
    if (tip === null) return errorResult(404, 'Not Found');
    const commitObj = repo.objects.get(tip);
    const parsed = commitObj?.type === 'commit' ? parseCommit(commitObj.data) : null;
    if (parsed === null) return errorResult(404, 'Not Found');
    if (rest.length === 0) {
      // The repository root: list its top-level entries.
      const entries = parseTree(repo.objects.get(parsed.tree)?.data ?? Buffer.alloc(0)).map((entry) => ({
        type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
        size: entry.mode === '40000' || entry.mode === '040000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      }));
      return jsonResult(200, entries);
    }
    const found = lookupPath(repo, parsed.tree, rest);
    if (found === null) return errorResult(404, 'Not Found');
    if (found.kind === 'dir') {
      const obj = repo.objects.get(found.oid);
      const entries = obj === undefined ? [] : parseTree(obj.data).map((entry) => ({
        type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' : 'file',
        name: entry.name,
        path: `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' || entry.mode === '040000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      }));
      return jsonResult(200, entries);
    }
    const blob = repo.objects.get(found.oid);
    if (blob === undefined) return errorResult(404, 'Not Found');
    return jsonResult(200, {
      type: 'file',
      encoding: 'base64',
      content: b64encode(blob.data),
      sha: found.oid,
      size: blob.data.length,
      name: rest[rest.length - 1],
      path,
    });
  }
  if (method === 'PUT') {
    let body: Record<string, unknown> | null;
    try {
      body = parseBody(bodyText);
    } catch (err) {
      return errorResult(400, err instanceof Error ? err.message : 'Problems parsing JSON');
    }
    const contentB64 = str(body, 'content');
    if (contentB64 === '') return errorResult(422, 'Validation Failed: content is required');
    const content = b64decode(contentB64);
    if (content === null) return errorResult(422, 'Validation Failed: content is not valid base64');
    const message = str(body, 'message', `Update ${path}`);
    const branch = str(body, 'branch', repo.defaultBranch) || repo.defaultBranch;
    const sha = typeof body?.sha === 'string' && body.sha !== '' ? body.sha : undefined;
    const parts = splitRepoPath(path);
    if (parts === null) return errorResult(422, 'Validation Failed: invalid path');
    const cleanPath = parts.join('/');
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const existed = tip !== undefined && commitFlatTree(repo, tip).has(cleanPath);
    if (existed && sha === undefined) return errorResult(422, 'Validation Failed: sha is required to update a file');
    const result = commitFile(repo, branch, cleanPath, content, message, sha);
    if ('error' in result) {
      if (result.error === 'stale') return errorResult(409, 'The sha does not match the current file');
      return errorResult(404, 'Not Found');
    }
    const blobSha = result.blobSha ?? '';
    return jsonResult(existed ? 200 : 201, {
      content: { name: parts[parts.length - 1], path: cleanPath, sha: blobSha, size: content.length, encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
  }
  if (method === 'DELETE') {
    let body: Record<string, unknown> | null;
    try {
      body = parseBody(bodyText);
    } catch (err) {
      return errorResult(400, err instanceof Error ? err.message : 'Problems parsing JSON');
    }
    const message = str(body, 'message', `Delete ${path}`);
    const branch = str(body, 'branch', repo.defaultBranch) || repo.defaultBranch;
    const sha = typeof body?.sha === 'string' && body.sha !== '' ? body.sha : undefined;
    const parts = splitRepoPath(path);
    if (parts === null) return errorResult(422, 'Validation Failed: invalid path');
    const result = commitFile(repo, branch, parts.join('/'), null, message, sha);
    if ('error' in result) {
      if (result.error === 'stale') return errorResult(409, 'The sha does not match the current file');
      return errorResult(404, 'Not Found');
    }
    return jsonResult(200, { commit: { sha: result.commitSha, message }, content: null });
  }
  return errorResult(404, 'Not Found');
}

// ---------------------------------------------------------------- labels

function handleLabels(store: Store, repo: Repo, rest: readonly string[], method: string, bodyText: string): HttpResult {
  if (rest.length !== 0) return errorResult(404, 'Not Found');
  if (method === 'GET') return jsonResult(200, [...repo.labels.values()].map(labelJson));
  if (method === 'POST') {
    let body: Record<string, unknown> | null;
    try {
      body = parseBody(bodyText);
    } catch (err) {
      return errorResult(400, err instanceof Error ? err.message : 'Problems parsing JSON');
    }
    const name = str(body, 'name');
    if (name === '') return errorResult(422, 'Validation Failed: name is required');
    if (repo.labels.has(name.toLowerCase())) return errorResult(422, 'Validation Failed: label already exists');
    const color = str(body, 'color', 'ededed').replace(/^#/, '') || 'ededed';
    const label: Label = { id: store.nextLabelId++, name, color };
    repo.labels.set(name.toLowerCase(), label);
    return jsonResult(201, labelJson(label));
  }
  return errorResult(404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function handleIssues(
  store: Store,
  repo: Repo,
  rest: readonly string[],
  method: string,
  query: Query,
  bodyText: string,
  host: string,
  path: string,
): HttpResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return listResult(host, path, query, issues.map((issue) => issueJson(repo, issue)));
    }
    if (method === 'POST') {
      let body: Record<string, unknown> | null;
      try {
        body = parseBody(bodyText);
      } catch (err) {
        return errorResult(400, err instanceof Error ? err.message : 'Problems parsing JSON');
      }
      const title = str(body, 'title');
      if (title === '') return errorResult(422, 'Validation Failed: title is required');
      const labelNames: string[] = [];
      const rawLabels = body?.labels;
      if (Array.isArray(rawLabels)) {
        for (const entry of rawLabels) {
          if (typeof entry === 'string') labelNames.push(entry);
          else if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).name === 'string') {
            labelNames.push((entry as Record<string, unknown>).name as string);
          }
        }
      }
      const labels: Label[] = [];
      for (const name of labelNames) {
        const label = repo.labels.get(name.toLowerCase());
        if (label === undefined) return errorResult(422, `Validation Failed: label does not exist: ${name}`);
        labels.push(label);
      }
      const now = tickIso();
      const issue: Issue = {
        id: store.nextIssueId++,
        number: store.nextNumber(repo),
        title,
        body: str(body, 'body'),
        state: 'open',
        labels,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return jsonResult(201, issueJson(repo, issue));
    }
    return errorResult(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) return errorResult(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return errorResult(404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') return jsonResult(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      let body: Record<string, unknown> | null;
      try {
        body = parseBody(bodyText);
      } catch (err) {
        return errorResult(400, err instanceof Error ? err.message : 'Problems parsing JSON');
      }
      if (body !== null) {
        if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'closed' && issue.state !== 'closed') {
          issue.state = 'closed';
          issue.closedAt = tickIso();
        } else if (body.state === 'open' && issue.state !== 'open') {
          issue.state = 'open';
          issue.closedAt = null;
        }
        issue.updatedAt = tickIso();
      }
      return jsonResult(200, issueJson(repo, issue));
    }
    return errorResult(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') return jsonResult(200, issue.comments.map(commentJson));
    if (method === 'POST') {
      let body: Record<string, unknown> | null;
      try {
        body = parseBody(bodyText);
      } catch (err) {
        return errorResult(400, err instanceof Error ? err.message : 'Problems parsing JSON');
      }
      const now = tickIso();
      const comment: Comment = { id: store.nextCommentId++, body: str(body, 'body'), createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      issue.updatedAt = now;
      return jsonResult(201, commentJson(comment));
    }
    return errorResult(404, 'Not Found');
  }
  return errorResult(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function handlePulls(
  store: Store,
  repo: Repo,
  rest: readonly string[],
  method: string,
  query: Query,
  bodyText: string,
  host: string,
  path: string,
): HttpResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      return listResult(host, path, query, pulls.map((pull) => pullJson(repo, pull)));
    }
    if (method === 'POST') {
      let body: Record<string, unknown> | null;
      try {
        body = parseBody(bodyText);
      } catch (err) {
        return errorResult(400, err instanceof Error ? err.message : 'Problems parsing JSON');
      }
      const title = str(body, 'title');
      if (title === '') return errorResult(422, 'Validation Failed: title is required');
      const headRaw = str(body, 'head');
      const baseRaw = str(body, 'base');
      const head = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined) return errorResult(422, `Validation Failed: head branch does not exist: ${head}`);
      if (baseSha === undefined) return errorResult(422, `Validation Failed: base branch does not exist: ${base}`);
      if (head === base) return errorResult(422, 'Validation Failed: head and base are the same branch');
      const now = tickIso();
      const pull: Pull = {
        id: store.nextIssueId++,
        number: store.nextNumber(repo),
        title,
        body: str(body, 'body'),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.pulls.set(pull.number, pull);
      return jsonResult(201, pullJson(repo, pull));
    }
    return errorResult(404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) return errorResult(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return errorResult(404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') return jsonResult(200, pullJson(repo, pull));
    return errorResult(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return errorResult(404, 'Not Found');
    const files = pullRequestFiles(repo, pull).map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
    }));
    return jsonResult(200, files);
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return errorResult(404, 'Not Found');
    if (pull.merged) return errorResult(405, 'Pull request has already been merged');
    if (pull.state !== 'open') return errorResult(405, 'Pull request is closed');
    const sha = squashMerge(store, repo, pull);
    if (sha === null) return errorResult(405, 'Pull request is not mergeable: merge conflict');
    const now = tickIso();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.mergeCommitSha = sha;
    pull.closedAt = now;
    pull.updatedAt = now;
    return jsonResult(200, { sha, merged: true, message: `Pull request #${pull.number} successfully merged` });
  }
  return errorResult(404, 'Not Found');
}

// Re-exported for the GraphQL and MCP surfaces.
export { diffFlatTrees, commitFlatTree };
