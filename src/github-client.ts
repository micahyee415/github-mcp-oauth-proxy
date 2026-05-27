/**
 * GitHub REST API client.
 *
 * Thin wrapper around fetch — no Octokit dependency.
 * All calls are read-only; the PAT is scoped to repos/issues/PRs/contents.
 */

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHubClient {
  private readonly headers: Record<string, string>;

  constructor(pat: string) {
    this.headers = {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    };
  }

  private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const url = new URL(`${GITHUB_API}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      headers: this.headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = (() => {
        try { return (JSON.parse(body) as { message?: string }).message ?? body; }
        catch { return body; }
      })();
      throw new GitHubError(`GitHub API error ${res.status}: ${msg}`, res.status);
    }

    return res.json() as Promise<T>;
  }

  // ── Repos ────────────────────────────────────────────────────────────────────

  async listRepos(params: { per_page?: number; page?: number } = {}): Promise<GHRepo[]> {
    return this.get<GHRepo[]>("/user/repos", {
      per_page: params.per_page ?? 30,
      page: params.page ?? 1,
      sort: "updated",
    });
  }

  async getRepo(owner: string, repo: string): Promise<GHRepo> {
    return this.get<GHRepo>(`/repos/${owner}/${repo}`);
  }

  async searchRepos(query: string, per_page = 20): Promise<GHSearchResult<GHRepo>> {
    return this.get<GHSearchResult<GHRepo>>("/search/repositories", { q: query, per_page });
  }

  // ── Issues ───────────────────────────────────────────────────────────────────

  async listIssues(owner: string, repo: string, params: {
    state?: "open" | "closed" | "all";
    per_page?: number;
    page?: number;
  } = {}): Promise<GHIssue[]> {
    return this.get<GHIssue[]>(`/repos/${owner}/${repo}/issues`, {
      state: params.state ?? "open",
      per_page: params.per_page ?? 30,
      page: params.page ?? 1,
    });
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GHIssue> {
    return this.get<GHIssue>(`/repos/${owner}/${repo}/issues/${issueNumber}`);
  }

  async listIssueComments(owner: string, repo: string, issueNumber: number, per_page = 30): Promise<GHComment[]> {
    return this.get<GHComment[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { per_page });
  }

  async searchIssues(query: string, per_page = 20): Promise<GHSearchResult<GHIssue>> {
    return this.get<GHSearchResult<GHIssue>>("/search/issues", { q: query, per_page });
  }

  // ── Pull Requests ─────────────────────────────────────────────────────────────

  async listPullRequests(owner: string, repo: string, params: {
    state?: "open" | "closed" | "all";
    per_page?: number;
    page?: number;
  } = {}): Promise<GHPR[]> {
    return this.get<GHPR[]>(`/repos/${owner}/${repo}/pulls`, {
      state: params.state ?? "open",
      per_page: params.per_page ?? 30,
      page: params.page ?? 1,
    });
  }

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<GHPR> {
    return this.get<GHPR>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  }

  async listPRFiles(owner: string, repo: string, prNumber: number, per_page = 50): Promise<GHPRFile[]> {
    return this.get<GHPRFile[]>(`/repos/${owner}/${repo}/pulls/${prNumber}/files`, { per_page });
  }

  // ── Code / Contents ───────────────────────────────────────────────────────────

  async getContents(owner: string, repo: string, path: string, ref?: string): Promise<GHContent | GHContent[]> {
    const params: Record<string, string> = {};
    if (ref) params.ref = ref;
    return this.get<GHContent | GHContent[]>(`/repos/${owner}/${repo}/contents/${path}`, params);
  }

  async searchCode(query: string, per_page = 20): Promise<GHSearchResult<GHCodeResult>> {
    return this.get<GHSearchResult<GHCodeResult>>("/search/code", { q: query, per_page });
  }

  async listCommits(owner: string, repo: string, params: {
    sha?: string;
    path?: string;
    per_page?: number;
    page?: number;
  } = {}): Promise<GHCommit[]> {
    const p: Record<string, string | number> = {
      per_page: params.per_page ?? 20,
      page: params.page ?? 1,
    };
    if (params.sha) p.sha = params.sha;
    if (params.path) p.path = params.path;
    return this.get<GHCommit[]>(`/repos/${owner}/${repo}/commits`, p);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GHRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  open_issues_count: number;
  updated_at: string;
}

export interface GHIssue {
  number: number;
  title: string;
  state: string;
  body: string | null;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  pull_request?: { url: string }; // present if the issue is a PR
}

export interface GHComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
}

export interface GHPR {
  number: number;
  title: string;
  state: string;
  body: string | null;
  user: { login: string } | null;
  html_url: string;
  base: { ref: string };
  head: { ref: string; sha: string };
  merged: boolean;
  created_at: string;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

export interface GHPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GHContent {
  type: "file" | "dir" | "symlink";
  name: string;
  path: string;
  sha: string;
  size: number;
  html_url: string | null;
  download_url: string | null;
  content?: string;   // base64 encoded, only for files
  encoding?: string;
}

export interface GHCodeResult {
  name: string;
  path: string;
  sha: string;
  html_url: string;
  repository: { full_name: string };
}

export interface GHCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
}

export interface GHSearchResult<T> {
  total_count: number;
  incomplete_results: boolean;
  items: T[];
}
