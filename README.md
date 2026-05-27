# github-mcp-proxy

> An authenticating proxy for the GitHub REST API, exposing read-only GitHub access as MCP tools behind Google OAuth (domain-restricted). Deploy to Cloud Run and connect any MCP-compatible AI client.

## Overview

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) lets AI clients call structured tools. This server exposes a read-only subset of the GitHub API as MCP tools — repos, issues, pull requests, file contents, code search, and commit history.

**Why add an auth layer?**

The official GitHub MCP server is designed for local use and assumes the user running it already has access. This proxy makes MCP-over-HTTP safe for shared, remote deployment by adding:

- **Google OAuth validation** on every request — the Bearer token is verified against Google's tokeninfo endpoint, confirming it is valid, unexpired, and issued to a verified `@example.com` email address.
- **Audience check** — the token must have been issued for your specific Google OAuth client, preventing token reuse from other Google-integrated apps.
- **Per-user rate limiting** — 60 requests per minute per authenticated user.
- **Dynamic Client Registration (RFC 7591)** — MCP clients that support OAuth discovery (such as Claude) can register and authenticate automatically using the `/.well-known/` metadata endpoints.

The GitHub API calls themselves are made directly from the proxy using a service-account fine-grained PAT. No sidecar process is required.

## MCP Tools

All tools are read-only. The GitHub PAT should be scoped to match the repositories and operations you intend to expose.

| Tool | Description |
|---|---|
| `list_repos` | List repositories accessible to the service account (name, language, open issue count, last updated) |
| `get_repo` | Get full details about a specific repository |
| `search_repos` | Search repositories by keyword or qualifier (e.g. `org:your-org language:typescript`) |
| `list_issues` | List issues for a repository; excludes pull requests |
| `get_issue` | Get full details and comments for a specific issue |
| `search_issues` | Search issues and PRs using GitHub's search syntax (e.g. `bug repo:your-org/your-repo is:open`) |
| `list_pull_requests` | List pull requests for a repository |
| `get_pull_request` | Get full PR details including description and diff stats |
| `list_pr_files` | List files changed in a PR, with optional diff patches |
| `get_file_contents` | Read the contents of a file from a repository |
| `list_directory` | Browse files and subdirectories at a path in a repository |
| `search_code` | Search code across repositories (e.g. `useState repo:your-org/your-repo`) |
| `list_commits` | List recent commits for a repository or a specific file path |

## Architecture

```
MCP Client (e.g. Claude)
        |
        | HTTPS  Bearer <Google OAuth token>
        v
+---------------------------+
|    github-mcp-proxy       |
|  (Express + MCP SDK)      |
|                           |
|  1. Verify Google token   |  --> oauth2.googleapis.com/tokeninfo
|     - email verified?     |
|     - domain matches?     |
|     - audience matches?   |
|                           |
|  2. Per-user rate limit   |
|     (60 req/min)          |
|                           |
|  3. Handle MCP request    |
|     (StreamableHTTP)      |
|                           |
|  4. Call GitHub REST API  |  --> api.github.com
|     (service PAT)         |
+---------------------------+
        |
        | JSON response
        v
MCP Client
```

**OAuth flow (automatic with supported clients):**

1. Client discovers `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`.
2. Client registers via `POST /register` (RFC 7591 Dynamic Client Registration), receiving your Google OAuth client credentials.
3. Client redirects the user through Google's OAuth consent flow (`accounts.google.com`).
4. Client receives a Google access token and sends it as `Authorization: Bearer <token>` on every MCP request.
5. The proxy verifies the token on each request (with a 60-second in-memory cache, keyed by SHA-256 hash of the token).

**Transport:** StreamableHTTP (stateless, one MCP server instance per request). Compatible with MCP clients that support remote HTTP servers.

**Deployment:** Docker → Google Cloud Build → Cloud Run (`service.yaml`). Secrets (PAT, OAuth credentials) are injected from GCP Secret Manager at runtime — never baked into the image.

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 22, TypeScript 5 |
| HTTP server | Express 5 |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Schema validation | Zod |
| Auth | Google OAuth 2.0 (tokeninfo endpoint) |
| GitHub API | Native `fetch` (no Octokit) |
| Container | Docker, multi-stage build, non-root user |
| Deploy | GCP Cloud Build + Cloud Run |
| Secret management | GCP Secret Manager |
| Dependency updates | Dependabot (weekly, npm) |

## Getting Started

### Prerequisites

- Node.js 22+
- A GitHub fine-grained PAT with read access to the repositories you want to expose
- A GCP project with a Google OAuth 2.0 web app client configured
- (For Cloud Run deployment) GCP project with Cloud Build and Cloud Run APIs enabled

### Install

```bash
git clone https://github.com/micahyee415/github-mcp-oauth-proxy
cd github-mcp-oauth-proxy
npm install
```

### Configuration

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `PORT` | HTTP port (default: `8080`) |
| `GITHUB_PAT` | GitHub fine-grained PAT — read-only, scoped to your target repos |
| `GITHUB_MCP_URL` | Reserved for future use; set to `http://localhost:8082` locally |
| `ALLOWED_DOMAIN` | Email domain that may authenticate (e.g. `example.com`) |
| `SERVER_URL` | Public base URL of this server (used in OAuth metadata responses) |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID (web app type) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret |

Secrets are injected from GCP Secret Manager in Cloud Run (see `service.yaml`). For local development, a `.env` file is sufficient.

### Run locally

```bash
npm run dev
```

The server starts on `http://localhost:8080`. The `/health` endpoint confirms it is running:

```bash
curl http://localhost:8080/health
# {"status":"ok","version":"1.0.0","transport":"http"}
```

### Deploy to Cloud Run

1. Edit `service.yaml` — update `ALLOWED_DOMAIN`, `SERVER_URL`, and the GCP Secret Manager secret names to match your project.
2. Add your secrets to GCP Secret Manager: `github-pat`, `github-oauth-id`, `github-oauth-secret`.
3. Submit the build:

```bash
gcloud builds submit --config cloudbuild.yaml --project your-gcp-project .
```

Cloud Build will:
- Run `npm audit` and fail on high/critical vulnerabilities.
- Build and push a Docker image tagged with the commit SHA.
- Deploy a new Cloud Run revision via `service.yaml`.

After deployment, update `SERVER_URL` in `service.yaml` to your Cloud Run service URL and redeploy.

## Connecting an MCP Client

Add the server to your MCP client's configuration. The exact format depends on the client; for a remote HTTP server it typically looks like:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://your-service.example.com/mcp"
    }
  }
}
```

If your client supports OAuth discovery (e.g. Claude.ai remote MCP), it will detect the `/.well-known/` endpoints, register automatically, and prompt you to authenticate with Google. No manual token handling required.

## Security

- **Domain restriction:** Only verified email addresses matching `ALLOWED_DOMAIN` are accepted. The check is enforced server-side on the verified claim returned by Google — not on user-supplied input.
- **Audience validation:** Tokens must be issued for your specific Google OAuth client ID, preventing reuse of tokens from other applications.
- **Token hashing:** Tokens are stored in the in-memory cache as SHA-256 hashes. The raw token is never persisted.
- **Read-only:** All GitHub API calls are read operations. The PAT should be scoped to the minimum necessary repositories and permissions.
- **Non-root container:** The Docker image runs as a non-root user.
- **Security headers:** `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, and `Cache-Control: no-store` are set on all responses.
- **Rate limiting:** 60 requests per minute per authenticated user; 10 Dynamic Client Registrations per minute globally.
- **Dependency scanning:** Dependabot is configured for weekly npm updates. Cloud Build runs `npm audit --audit-level=high` and fails the build on unresolved high or critical CVEs.
- **Secret management:** All credentials are loaded from GCP Secret Manager at runtime. No secrets are baked into the Docker image or committed to the repository.

To report a security vulnerability, see [SECURITY.md](SECURITY.md).

## License

MIT
