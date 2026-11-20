// Model Context Protocol at /mcp: JSON-RPC 2.0 over Streamable HTTP (application/json).
// Revision 2026-07-28 via server/discover, plus the legacy initialize handshake. Six tools,
// the github-mcp-server argument shapes, acting on the same store as REST and GraphQL.

import { VIEWER, squashMerge, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { errorResult, jsonResult, tickIso, type HttpResult } from './util.ts';

const SERVER_NAME = 'merlin-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ACCEPTED_REVISIONS = new Set(SUPPORTED_VERSIONS);

// ---------------------------------------------------------------- the tool list (static: two tools/list calls answer byte-identical lists)

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner of the repository (the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// ---------------------------------------------------------------- JSON-RPC plumbing

function rpcResult(id: unknown, result: unknown): HttpResult {
  return jsonResult(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, httpStatus = 200): HttpResult {
  return jsonResult(httpStatus, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** A successful tool result: text content plus structured content (the checks read both). */
function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** A failed tool call: isError true with the reason as text. */
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------- tool dispatch

/** Resolve owner/repo from tool arguments (owner+repo, or a full_name fallback). */
function repoOfArgs(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      owner = args.full_name.slice(0, slash);
      repo = args.full_name.slice(slash + 1);
    }
  }
  if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return null;
  return store.getRepo(owner, repo);
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function numArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { __rpcError: -32601, __message: `Unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { __rpcError: -32602, __message: `Missing required argument: ${required}` };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      const description = strArg(args, 'description');
      const isPrivate = args.private === true;
      const repo = store.createRepo(VIEWER.login, repoName, isPrivate, description);
      if (repo === null) return toolError(`Repository ${repoName} already exists`);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoOfArgs(store, args);
      if (repo === null) return toolError('Repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoOfArgs(store, args);
      if (repo === null) return toolError('Repository not found');
      const now = tickIso();
      const issue: Issue = {
        id: store.nextIssueId++,
        number: store.nextNumber(repo),
        title: strArg(args, 'title'),
        body: strArg(args, 'body'),
        state: 'open',
        labels: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoOfArgs(store, args);
      if (repo === null) return toolError('Repository not found');
      const state = strArg(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoOfArgs(store, args);
      if (repo === null) return toolError('Repository not found');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined) return toolError(`Head branch does not exist: ${head}`);
      if (baseSha === undefined) return toolError(`Base branch does not exist: ${base}`);
      const now = tickIso();
      const pull: Pull = {
        id: store.nextIssueId++,
        number: store.nextNumber(repo),
        title: strArg(args, 'title'),
        body: strArg(args, 'body'),
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
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOfArgs(store, args);
      if (repo === null) return toolError('Repository not found');
      const number = numArg(args, 'pull_number');
      if (number === null) return toolError('pull_number must be an integer');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`Pull request #${number} not found`);
      if (pull.merged) return toolError('Pull request has already been merged');
      if (pull.state !== 'open') return toolError('Pull request is closed');
      const sha = squashMerge(store, repo, pull);
      if (sha === null) return toolError('Pull request is not mergeable: merge conflict');
      const now = tickIso();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = now;
      pull.mergeCommitSha = sha;
      pull.closedAt = now;
      pull.updatedAt = now;
      return toolResult({ ...pullJson(repo, pull), sha, merged: true, message: `Pull request #${number} successfully merged` });
    }
    default:
      return { __rpcError: -32601, __message: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------- the endpoint

/** POST /mcp (auth already checked by the caller). */
export function handleMcp(store: Store, method: string, bodyText: string): HttpResult {
  if (method !== 'POST') return errorResult(405, 'Method Not Allowed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const body = parsed as Record<string, unknown>;
  const id = body.id ?? null;
  const isNotification = body.id === undefined;
  const methodName = body.method;
  if (typeof methodName !== 'string') {
    if (isNotification) return { status: 202, body: '' };
    return rpcError(id, -32600, 'Invalid Request');
  }
  // Notifications (no id) get an empty 202; the client ignores the body.
  if (isNotification) return { status: 202, body: '' };

  if (methodName === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (methodName === 'initialize') {
    const params = (body.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = ACCEPTED_REVISIONS.has(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (methodName === 'ping') return rpcResult(id, {});
  if (methodName === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (methodName === 'tools/call') {
    const params = (body.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return rpcError(id, -32602, 'Invalid params: arguments must be an object');
    }
    const outcome = callTool(store, toolName, args);
    if ('__rpcError' in outcome) {
      return rpcError(id, outcome.__rpcError as number, String(outcome.__message ?? 'Tool call failed'));
    }
    return rpcResult(id, outcome);
  }
  return rpcError(id, -32601, `Method not found: ${methodName}`);
}
