// GitHub GraphQL v4 at /api/graphql: a small executor for the fixed documents gh and
// github-mcp-server send (the 17 in checks-graphql.ts). It parses operations, fields, aliases,
// arguments (variables, literals, enums, input objects, lists) and inline fragments; it resolves
// against the same store as REST and MCP. Unknown fields answer HTTP 200 with an `errors` array
// naming them; an unknown repository is data.repository = null with no errors.

import {
  VIEWER,
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  pullRequestConflict,
  pullRequestFiles,
  repoGlobalId,
  squashMerge,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { errorResult, jsonResult, tickIso, type HttpResult } from './util.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === '"') value += '"';
          else if (esc === '\\') value += '\\';
          else if (esc === '/') value += '/';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u' && i + 5 < input.length) {
            value += String.fromCharCode(parseInt(input.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      if (i >= input.length) throw new Error('unterminated string in query');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in query`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

/** A parsed value: literals, variables, lists, input objects. */
export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

/** One field (or inline fragment) in a selection set. */
export interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[] | null;
}

export type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: GqlSelection[] };

export interface GqlOperation {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: GqlValue | null }>;
  selections: GqlSelection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of query');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in query`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in query');
    return token.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek() !== null) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('empty query document');
    return operations;
  }

  private parseOperation(): GqlOperation {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = token.value;
      this.next();
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value as string;
    }
    const variables: Array<{ name: string; defaultValue: GqlValue | null }> = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: GqlValue | null = null;
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { operation, name, variables, selections };
  }

  /** Skip a type annotation (Named, [List], Non-null !). */
  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      if (this.peek() === null) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') throw new Error('named fragments are not supported');
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in query');
  }
}

// ---------------------------------------------------------------- executor

/** A resolved value: scalars, null, arrays, or a typed object the executor can select into. */
type Resolved =
  | string
  | number
  | boolean
  | null
  | Resolved[]
  | { __type: string; __value: unknown };

/** An object wrapper for the executor. */
function obj(type: string, value: unknown): Resolved {
  return { __type: type, __value: value };
}

function isObj(value: Resolved): value is { __type: string; __value: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '__type' in value;
}

/** Introspection data: the fields and enum values each named type reports. */
const TYPE_INFO: Readonly<Record<string, { kind: string; fields: readonly string[]; enumValues?: readonly string[] }>> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id',
      'databaseId',
      'name',
      'nameWithOwner',
      'owner',
      'defaultBranchRef',
      'viewerPermission',
      'hasIssuesEnabled',
      'issue',
      'issues',
      'pullRequests',
      'pullRequest',
    ],
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'] },
};

/** Decode a value node against the operation's variables. */
function resolveValue(value: GqlValue, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'variable': {
      const found = variables[value.name];
      return found === undefined ? null : found;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

/** An issue cursor: base64 of `cursor:<number>`. */
function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^cursor:(\d+)$/.exec(text);
  return match === null ? null : Number(match[1]);
}

class Executor {
  readonly errors: Array<{ message: string }> = [];
  private readonly store: Store;
  private readonly variables: Readonly<Record<string, unknown>>;

  constructor(store: Store, variables: Readonly<Record<string, unknown>>) {
    this.store = store;
    this.variables = variables;
  }

  private error(message: string): void {
    this.errors.push({ message });
  }

  /** Resolve one operation's selection set against a root object. */
  execute(operation: GqlOperation): Record<string, unknown> {
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    return this.select(obj(rootType, null), operation.selections) as Record<string, unknown>;
  }

  /** Resolve a selection set against a typed object; returns a plain JSON object. */
  private select(value: Resolved, selections: readonly GqlSelection[]): unknown {
    if (value === null) return null;
    if (!isObj(value)) return value;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== value.__type) continue;
        const inner = this.select(value, selection.selections);
        if (typeof inner === 'object' && inner !== null) Object.assign(out, inner);
        continue;
      }
      const field = selection.field;
      const key = field.alias ?? field.name;
      out[key] = this.resolveField(value, field);
    }
    return out;
  }

  /** Resolve one field on a typed object (or record an error and return null). */
  private resolveField(parent: { __type: string; __value: unknown }, field: GqlField): unknown {
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = resolveValue(arg.value, this.variables);
    const result = this.fieldValue(parent, field.name, args, field);
    if (result === undefined) {
      this.error(`Cannot query field "${field.name}" on type "${parent.__type}".`);
      return null;
    }
    if (result === null) return null;
    if (Array.isArray(result)) {
      if (field.selections === null) return result;
      return result.map((entry) => (isObj(entry) ? this.select(entry, field.selections!) : entry));
    }
    if (isObj(result)) {
      if (field.selections === null) {
        this.error(`Field "${field.name}" of type "${result.__type}" must have a selection of subfields.`);
        return null;
      }
      return this.select(result, field.selections);
    }
    if (field.selections !== null) {
      this.error(`Field "${field.name}" must not have a selection since type "${typeof result}" has no subfields.`);
      return null;
    }
    return result;
  }

  /** The raw value of a field, or undefined when the type has no such field. */
  private fieldValue(
    parent: { __type: string; __value: unknown },
    name: string,
    args: Readonly<Record<string, unknown>>,
    field: GqlField,
  ): Resolved | undefined {
    const type = parent.__type;
    const value = parent.__value;
    if (type === 'Query') return this.queryField(name, args);
    if (type === 'Mutation') return this.mutationField(name, args);
    if (type === 'User') {
      if (name === 'login') return VIEWER.login;
      if (name === 'id') return `VXNlcjoxMDAw`;
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
      return undefined;
    }
    if (type === 'Ref') {
      if (name === 'name') return (value as { name: string }).name;
      return undefined;
    }
    if (type === 'Repository') return this.repositoryField(value as Repo, name, args);
    if (type === 'Issue') return this.issueField(value as { repo: Repo; issue: Issue }, name);
    if (type === 'IssueConnection') return this.issueConnectionField(value as { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; repo: Repo }, name);
    if (type === 'PageInfo') {
      const pageInfo = value as { hasNextPage: boolean; endCursor: string | null };
      if (name === 'hasNextPage') return pageInfo.hasNextPage;
      if (name === 'endCursor') return pageInfo.endCursor;
      return undefined;
    }
    if (type === 'PullRequest') return this.pullField(value as { repo: Repo; pull: Pull }, name, args);
    if (type === 'PullRequestConnection') {
      if (name === 'nodes') {
        const conn = value as { repo: Repo; pulls: Pull[] };
        return conn.pulls.map((pull) => obj('PullRequest', { repo: conn.repo, pull }));
      }
      if (name === 'pageInfo') return obj('PageInfo', { hasNextPage: false, endCursor: null });
      return undefined;
    }
    if (type === 'PullRequestChangedFileConnection') {
      if (name === 'nodes') {
        const files = value as Array<{ path: string }>;
        return files.map((file) => obj('PullRequestChangedFile', file));
      }
      return undefined;
    }
    if (type === 'PullRequestChangedFile') {
      if (name === 'path') return (value as { path: string }).path;
      return undefined;
    }
    if (type === '__Type') {
      const info = value as { name: string; kind: string; fields: readonly string[]; enumValues?: readonly string[] };
      if (name === 'name') return info.name;
      if (name === 'kind') return info.kind;
      if (name === 'fields') return info.fields.map((fieldName) => obj('__Field', { name: fieldName }));
      if (name === 'enumValues') return (info.enumValues ?? []).map((enumName) => obj('__EnumValue', { name: enumName }));
      return undefined;
    }
    if (type === '__Field' || type === '__EnumValue') {
      if (name === 'name') return (value as { name: string }).name;
      return undefined;
    }
    if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
      if (name === 'issue') {
        const issue = value as { repo: Repo; issue: Issue } | null;
        return issue === null ? null : obj('Issue', issue);
      }
      return undefined;
    }
    if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
      if (name === 'pullRequest') {
        const pull = value as { repo: Repo; pull: Pull } | null;
        return pull === null ? null : obj('PullRequest', pull);
      }
      return undefined;
    }
    if (type === 'AddCommentPayload') {
      if (name === 'commentEdge') {
        const edge = value as { repo: Repo; issue: Issue; comment: Comment } | null;
        return edge === null ? null : obj('IssueCommentEdge', edge);
      }
      return undefined;
    }
    if (type === 'IssueCommentEdge') {
      if (name === 'node') {
        const edge = value as { repo: Repo; issue: Issue; comment: Comment };
        return obj('IssueComment', edge);
      }
      if (name === 'cursor') return null;
      return undefined;
    }
    if (type === 'IssueComment') {
      const edge = value as { repo: Repo; issue: Issue; comment: Comment };
      if (name === 'id') return commentGlobalId(edge.repo, edge.issue, edge.comment);
      if (name === 'body') return edge.comment.body;
      return undefined;
    }
    return undefined;
  }

  private queryField(name: string, args: Readonly<Record<string, unknown>>): Resolved | undefined {
    if (name === 'viewer') return obj('User', null);
    if (name === 'repository') {
      const owner = args.owner;
      const repoName = args.name;
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return null;
      const repo = this.store.getRepo(owner, repoName);
      return repo === null ? null : obj('Repository', repo);
    }
    if (name === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = this.store.getRepoById(decoded.parts[0]!);
        return repo === null ? null : obj('Repository', repo);
      }
      if (decoded.kind === 'Issue') {
        const repo = this.store.getRepoById(decoded.parts[0]!);
        const issue = repo?.issues.get(decoded.parts[1]!);
        return issue === undefined || repo === null ? null : obj('Issue', { repo, issue });
      }
      if (decoded.kind === 'PullRequest') {
        const repo = this.store.getRepoById(decoded.parts[0]!);
        const pull = repo?.pulls.get(decoded.parts[1]!);
        return pull === undefined || repo === null ? null : obj('PullRequest', { repo, pull });
      }
      return null;
    }
    if (name === '__type') {
      const typeName = args.name;
      if (typeof typeName !== 'string') return null;
      const info = TYPE_INFO[typeName];
      if (info === undefined) return null;
      return obj('__Type', { name: typeName, kind: info.kind, fields: info.fields, enumValues: info.enumValues });
    }
    return undefined;
  }

  private repositoryField(repo: Repo, name: string, args: Readonly<Record<string, unknown>>): Resolved | undefined {
    if (name === 'id') return repoGlobalId(repo);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') return obj('User', null);
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : obj('Ref', { name: repo.defaultBranch });
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'issue') {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : obj('Issue', { repo, issue });
    }
    if (name === 'issues') {
      const first = typeof args.first === 'number' ? args.first : 30;
      const states = Array.isArray(args.states) ? (args.states as unknown[]) : null;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
      const afterNumber = decodeCursor(args.after);
      let issues = [...repo.issues.values()];
      if (states !== null) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      if (afterNumber !== null) {
        issues = issues.filter((issue) => (direction === 'DESC' ? issue.number < afterNumber : issue.number > afterNumber));
      }
      const page = issues.slice(0, Math.max(0, first));
      const hasNextPage = issues.length > page.length;
      const endCursor = page.length === 0 ? null : encodeCursor(page[page.length - 1]!.number);
      return obj('IssueConnection', { nodes: page, pageInfo: { hasNextPage, endCursor }, repo });
    }
    if (name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : 30;
      const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number).slice(0, Math.max(0, first));
      return obj('PullRequestConnection', { repo, pulls });
    }
    if (name === 'pullRequest') {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : obj('PullRequest', { repo, pull });
    }
    return undefined;
  }

  private issueField(pair: { repo: Repo; issue: Issue }, name: string): Resolved | undefined {
    const { repo, issue } = pair;
    if (name === 'id') return issueGlobalId(repo, issue);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'body') return issue.body;
    return undefined;
  }

  private issueConnectionField(
    conn: { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; repo: Repo },
    name: string,
  ): Resolved | undefined {
    if (name === 'nodes') return conn.nodes.map((issue) => obj('Issue', { repo: conn.repo, issue }));
    if (name === 'pageInfo') return obj('PageInfo', conn.pageInfo);
    return undefined;
  }

  private pullField(pair: { repo: Repo; pull: Pull }, name: string, args: Readonly<Record<string, unknown>>): Resolved | undefined {
    const { repo, pull } = pair;
    if (name === 'id') return pullGlobalId(repo, pull);
    if (name === 'number') return pull.number;
    if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'merged') return pull.merged;
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'mergeable') {
      if (pull.state !== 'open') return 'UNKNOWN';
      try {
        return pullRequestConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      } catch {
        return 'UNKNOWN';
      }
    }
    if (name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 30;
      const files = pullRequestFiles(repo, pull)
        .slice(0, Math.max(0, first))
        .map((change) => ({ path: change.filename }));
      return obj('PullRequestChangedFileConnection', files);
    }
    return undefined;
  }

  private mutationField(name: string, args: Readonly<Record<string, unknown>>): Resolved | undefined {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repo = this.repoFromGlobalId(input.repositoryId);
      if (repo === null) {
        this.error('Could not resolve to a Repository with the id provided.');
        return obj('CreateIssuePayload', null);
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const now = tickIso();
      const issue: Issue = {
        id: this.store.nextIssueId++,
        number: this.store.nextNumber(repo),
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return obj('CreateIssuePayload', { repo, issue });
    }
    if (name === 'closeIssue') {
      const pair = this.issueFromGlobalId(input.issueId);
      if (pair === null) {
        this.error('Could not resolve to an Issue with the id provided.');
        return obj('CloseIssuePayload', null);
      }
      pair.issue.state = 'closed';
      pair.issue.closedAt = tickIso();
      pair.issue.updatedAt = pair.issue.closedAt;
      return obj('CloseIssuePayload', pair);
    }
    if (name === 'createPullRequest') {
      const repo = this.repoFromGlobalId(input.repositoryId);
      if (repo === null) {
        this.error('Could not resolve to a Repository with the id provided.');
        return obj('CreatePullRequestPayload', null);
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        this.error('Head or base ref does not exist.');
        return obj('CreatePullRequestPayload', null);
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const now = tickIso();
      const pull: Pull = {
        id: this.store.nextIssueId++,
        number: this.store.nextNumber(repo),
        title,
        body: typeof input.body === 'string' ? input.body : '',
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
      return obj('CreatePullRequestPayload', { repo, pull });
    }
    if (name === 'mergePullRequest') {
      const pair = this.pullFromGlobalId(input.pullRequestId);
      if (pair === null) {
        this.error('Could not resolve to a PullRequest with the id provided.');
        return obj('MergePullRequestPayload', null);
      }
      if (pair.pull.merged || pair.pull.state !== 'open') {
        this.error('Pull request is not open.');
        return obj('MergePullRequestPayload', pair);
      }
      const sha = squashMerge(this.store, pair.repo, pair.pull);
      if (sha === null) {
        this.error('Pull request is not mergeable: merge conflict.');
        return obj('MergePullRequestPayload', pair);
      }
      const now = tickIso();
      pair.pull.state = 'closed';
      pair.pull.merged = true;
      pair.pull.mergedAt = now;
      pair.pull.mergeCommitSha = sha;
      pair.pull.closedAt = now;
      pair.pull.updatedAt = now;
      return obj('MergePullRequestPayload', pair);
    }
    if (name === 'addComment') {
      const pair = this.issueFromGlobalId(input.subjectId);
      if (pair === null) {
        this.error('Could not resolve to an Issue with the id provided.');
        return obj('AddCommentPayload', null);
      }
      const now = tickIso();
      const comment: Comment = {
        id: this.store.nextCommentId++,
        body: typeof input.body === 'string' ? input.body : '',
        createdAt: now,
        updatedAt: now,
      };
      pair.issue.comments.push(comment);
      pair.issue.updatedAt = now;
      return obj('AddCommentPayload', { repo: pair.repo, issue: pair.issue, comment });
    }
    return undefined;
  }

  private repoFromGlobalId(id: unknown): Repo | null {
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Repository') return null;
    return this.store.getRepoById(decoded.parts[0]!);
  }

  private issueFromGlobalId(id: unknown): { repo: Repo; issue: Issue } | null {
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const repo = this.store.getRepoById(decoded.parts[0]!);
    const issue = repo?.issues.get(decoded.parts[1]!);
    return repo === null || issue === undefined ? null : { repo, issue };
  }

  private pullFromGlobalId(id: unknown): { repo: Repo; pull: Pull } | null {
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'PullRequest') return null;
    const repo = this.store.getRepoById(decoded.parts[0]!);
    const pull = repo?.pulls.get(decoded.parts[1]!);
    return repo === null || pull === undefined ? null : { repo, pull };
  }
}

// ---------------------------------------------------------------- the endpoint

/** One operation's result body. */
function executeOperation(store: Store, body: Record<string, unknown>): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  let operations: GqlOperation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error in query.' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let operation = operations[0]!;
  if (operationName !== null) {
    const named = operations.find((op) => op.name === operationName);
    if (named !== undefined) operation = named;
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (!(variable.name in mergedVariables) && variable.defaultValue !== null) {
      mergedVariables[variable.name] = resolveValue(variable.defaultValue, variables);
    }
  }
  const executor = new Executor(store, mergedVariables);
  const data = executor.execute(operation);
  if (executor.errors.length > 0) return { data, errors: executor.errors };
  return { data };
}

/** POST /api/graphql (auth already checked by the caller). */
export function handleGraphQL(store: Store, bodyText: string): HttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return errorResult(400, 'Problems parsing JSON');
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      typeof entry === 'object' && entry !== null ? executeOperation(store, entry as Record<string, unknown>) : { errors: [{ message: 'Must provide query string.' }] },
    );
    return jsonResult(200, results);
  }
  if (typeof parsed !== 'object' || parsed === null) return errorResult(400, 'Must provide query string.');
  return jsonResult(200, executeOperation(store, parsed as Record<string, unknown>));
}
