// The forge's HTTP server: routing, body reading, auth, and the response envelope.
// Routes: GET /healthz, /api/v3/* (REST), POST /api/graphql, POST /mcp, and
// /{owner}/{repo}.git/* (git smart HTTP). Every reply is JSON (never HTML) except the git
// protocol's own binary answers, and every reply carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest, type Query } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { authorized, errorResult, jsonResult, nextRequestId, type HttpResult } from './util.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (packs in the suite are far below this). */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** Read a request body fully (as bytes); rejects when it exceeds the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Send one result: JSON by default, the result's own content-type when it sets one. */
function send(res: ServerResponse, result: HttpResult): void {
  const headers: Record<string, string> = { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) };
  const body = typeof result.body === 'string' ? Buffer.from(result.body, 'utf8') : result.body;
  if (result.status !== 204 && headers['content-type'] === undefined) headers['content-type'] = JSON_TYPE;
  headers['content-length'] = String(body.length);
  res.writeHead(result.status, headers);
  res.end(body);
}

/** Split a path into decoded segments, dropping empty ones. */
function segmentsOf(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    send(res, errorResult(404, 'Not Found'));
    return;
  }
  const method = req.method ?? 'GET';
  const pathname = url.pathname;
  const query: Query = new Map(url.searchParams.entries());
  const host = req.headers.host ?? 'entry';

  // The env's boot probe: 200 {"ok":true}, no token.
  if (method === 'GET' && pathname === '/healthz') {
    send(res, jsonResult(200, { ok: true }));
    return;
  }

  const body = await readBody(req);
  const bodyText = body.toString('utf8');
  const authHeader = req.headers.authorization;

  try {
    // REST v3.
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      const segments = segmentsOf(pathname.slice('/api/v3'.length));
      const isPublic = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
      if (!isPublic && !authorized(authHeader)) {
        send(res, errorResult(401, 'Bad credentials'));
        return;
      }
      send(res, handleRest(store, method, segments, query, bodyText, host, pathname));
      return;
    }

    // GraphQL v4.
    if (pathname === '/api/graphql') {
      if (method !== 'POST') {
        send(res, errorResult(404, 'Not Found'));
        return;
      }
      if (!authorized(authHeader)) {
        send(res, errorResult(401, 'Bad credentials'));
        return;
      }
      send(res, handleGraphQL(store, bodyText));
      return;
    }

    // MCP.
    if (pathname === '/mcp') {
      if (!authorized(authHeader)) {
        send(res, errorResult(401, 'Bad credentials'));
        return;
      }
      send(res, handleMcp(store, method, bodyText));
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/info/refs | /git-upload-pack | /git-receive-pack.
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
    if (gitMatch !== null) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const rest = gitMatch[3] ?? '';
      if (!authorized(authHeader)) {
        send(res, errorResult(401, 'Bad credentials'));
        return;
      }
      const gitProtocol = req.headers['git-protocol'];
      if (method === 'GET' && rest === '/info/refs') {
        send(res, handleInfoRefs(store, owner, repoName, query.get('service') ?? '', gitProtocol));
        return;
      }
      if (method === 'POST' && rest === '/git-upload-pack') {
        send(res, handleUploadPack(store, owner, repoName, body, gitProtocol));
        return;
      }
      if (method === 'POST' && rest === '/git-receive-pack') {
        send(res, handleReceivePack(store, owner, repoName, body));
        return;
      }
      send(res, errorResult(404, 'Not Found'));
      return;
    }

    // Everything else: GitHub's 404 body.
    send(res, errorResult(404, 'Not Found'));
  } catch (err) {
    // A handler's trouble is never the server's death: answer 500 and stay up.
    process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    send(res, errorResult(500, 'Internal Server Error'));
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      process.stderr.write(`[entry] request error: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        if (!res.headersSent) send(res, errorResult(500, 'Internal Server Error'));
        else res.end();
      } catch {
        // The socket is already gone.
      }
    });
  });
  server.keepAliveTimeout = 30_000;
  return server;
}
