# Changelog

## [1.0.1] - 2026-05-15

### Security

- Patched `fast-uri` ReDoS vulnerability via `npm audit fix` (GHSA-cc4q-3qf2-7vrm)

## [1.0.0] - 2026-04-20

### Added

- Initial release: read-only GitHub MCP server with Google OAuth (domain-restricted) access
- 13 MCP tools covering repos, issues, pull requests, file contents, code search, and commit history
- StreamableHTTP transport (stateless, one MCP server instance per request)
- Google OAuth token verification via `oauth2.googleapis.com/tokeninfo`
- Domain restriction and audience validation on every request
- Per-user rate limiting (60 req/min) and global registration rate limit (10 req/min)
- Dynamic Client Registration (RFC 7591) for automatic OAuth flow with supporting MCP clients
- In-memory token cache keyed by SHA-256 hash (60-second TTL)
- Structured JSON logging for GCP Cloud Logging
- Multi-stage Docker build with non-root runtime user
- GCP Cloud Build + Cloud Run deployment via `service.yaml`
- Secrets injected from GCP Secret Manager at runtime
- Dependabot configured for weekly npm dependency updates
