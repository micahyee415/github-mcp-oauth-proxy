/**
 * GitHub MCP Server
 *
 * Read-only GitHub access for @example.com accounts, deployed to Cloud Run.
 *
 * Architecture (same pattern as salesforce-mcp and gong-mcp):
 *   1. Express HTTP server with Google OAuth validation on every /mcp request
 *   2. Per-request McpServer + StreamableHTTPServerTransport (stateless)
 *   3. GitHub API calls made directly using a service PAT (no sidecar)
 *
 * Tools: list_repos, get_repo, search_repos,
 *        list_issues, get_issue, search_issues,
 *        list_pull_requests, get_pull_request, list_pr_files,
 *        get_file_contents, list_directory, search_code, list_commits
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GitHubClient } from "./github-client.js";
import { registerRepoTools } from "./tools/repos.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerPRTools } from "./tools/pull_requests.js";
import { registerCodeTools } from "./tools/code.js";
import { verifyGoogleToken, extractBearerToken, AuthError } from "./auth.js";
import { logger } from "./logger.js";
import { RateLimiter } from "./rate-limiter.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN ?? "example.com";
const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
const ALLOWED_ORIGINS = ["https://claude.ai", "https://api.claude.ai"];

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

// ─── GitHub client (shared, PAT is fixed) ────────────────────────────────────

const githubClient = new GitHubClient(requireEnv("GITHUB_PAT"));

// ─── MCP server factory ───────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "github", version: "1.0.0" });
  registerRepoTools(server, githubClient);
  registerIssueTools(server, githubClient);
  registerPRTools(server, githubClient);
  registerCodeTools(server, githubClient);
  return server;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const rateLimiter = new RateLimiter(60, 60_000);
const registerRateLimiter = new RateLimiter(10, 60_000); // 10 registrations/minute global
const app = express();
app.use(express.json({ limit: "256kb" }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", version: "1.0.0", transport: "http" });
});

// ─── OAuth metadata ───────────────────────────────────────────────────────────

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: SERVER_URL,
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    registration_endpoint: `${SERVER_URL}/register`,
    scopes_supported: ["openid", "email", "profile"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
  });
});

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: SERVER_URL,
    authorization_servers: ["https://accounts.google.com"],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
  });
});

app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json({
    resource: `${SERVER_URL}/mcp`,
    authorization_servers: ["https://accounts.google.com"],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
  });
});

// ─── Dynamic Client Registration (RFC 7591) ───────────────────────────────────

app.post("/register", (req, res) => {
  const origin = req.headers.origin;
  const ip = req.ip ?? "unknown";

  // 1. Origin check — reject requests from non-Claude origins
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    logger.warn("Registration rejected — disallowed origin", { event: "registration", origin, ip, allowed: false });
    res.status(403).json({ error: "Registration not allowed from this origin." });
    return;
  }

  // 2. Global rate limit — 10 registrations/minute
  if (!registerRateLimiter.check("__register__")) {
    const retryAfter = registerRateLimiter.retryAfter("__register__");
    logger.warn("Registration rate limit exceeded", { event: "rate_limited", ip, retryAfter });
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Registration rate limit exceeded. Try again in ${retryAfter}s.` });
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: "OAuth client credentials not configured on server." });
    return;
  }
  const redirectUris: string[] = (req.body?.redirect_uris ?? []).filter(
    (uri: unknown) => typeof uri === "string" && uri.startsWith("https://")
  );
  logger.info("Dynamic client registration", { event: "registration", origin: origin ?? "none", ip, allowed: true });
  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
});

// ─── MCP endpoint ─────────────────────────────────────────────────────────────

app.all("/mcp", async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;
    const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.status(204).end();
    return;
  }

  const startMs = Date.now();

  // 1. Extract and validate Google OAuth token
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    logger.warn("Missing auth token", { statusCode: 401 });
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource"`);
    res.status(401).json({ error: "Missing Authorization header. Use Bearer <Google OAuth token>." });
    return;
  }

  let userEmail: string;
  try {
    const authResult = await verifyGoogleToken(token, ALLOWED_DOMAIN);
    userEmail = authResult.email;
    logger.info("User authenticated", { event: "login", userEmail });
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn("Auth failed", { event: "auth_failure", statusCode: err.statusCode, reason: err.message });
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    logger.error("Unexpected auth error", { event: "auth_failure", reason: String(err) });
    res.status(500).json({ error: "Authentication failed." });
    return;
  }

  // 2. Per-user rate limiting
  if (!rateLimiter.check(userEmail)) {
    const retryAfter = rateLimiter.retryAfter(userEmail);
    logger.warn("Rate limit exceeded", { event: "rate_limited", userEmail, retryAfter });
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Rate limit exceeded. Try again in ${retryAfter}s.` });
    return;
  }

  // 3. CORS headers
  const origin = req.headers.origin;
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  // 4. Handle MCP request
  const tool: string | undefined =
    req.body?.method === "tools/call" ? req.body?.params?.name : req.body?.method;

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  logger.info("Request completed", {
    event: "usage",
    userEmail,
    tool,
    durationMs: Date.now() - startMs,
    statusCode: res.statusCode,
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const httpServer = app.listen(PORT, () => {
  logger.info("GitHub MCP server ready", { port: PORT });
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received — draining connections...");
  httpServer.close(() => {
    logger.info("HTTP server closed. Exiting.");
    process.exit(0);
  });
});
