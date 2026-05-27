import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitHubClient, GitHubError } from "../github-client.js";

function toolError(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerRepoTools(server: McpServer, client: GitHubClient): void {
  server.tool(
    "list_repos",
    "List GitHub repositories accessible to the service account. Returns repo names, descriptions, languages, and open issue counts.",
    {
      per_page: z.number().optional().describe("Results per page (1–100, default 30)"),
      page: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ per_page, page }) => {
      try {
        const repos = await client.listRepos({ per_page, page });
        const summary = repos.map(r => ({
          name: r.full_name,
          description: r.description,
          language: r.language,
          open_issues: r.open_issues_count,
          default_branch: r.default_branch,
          updated_at: r.updated_at,
          url: r.html_url,
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_repo",
    "Get details about a specific GitHub repository.",
    {
      owner: z.string().describe("Repository owner (username or org)"),
      repo: z.string().describe("Repository name"),
    },
    async ({ owner, repo }) => {
      try {
        const r = await client.getRepo(owner, repo);
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return toolError(`Repository ${owner}/${repo} not found.`);
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );

  server.tool(
    "search_repos",
    "Search GitHub repositories by keyword, language, or other qualifiers. Example queries: 'your-project language:typescript', 'org:your-org stars:>10'",
    {
      query: z.string().describe("GitHub search query (supports qualifiers like language:, org:, topic:)"),
      per_page: z.number().optional().describe("Results per page (1–30, default 20)"),
    },
    async ({ query, per_page }) => {
      try {
        const result = await client.searchRepos(query, per_page ?? 20);
        const summary = {
          total_count: result.total_count,
          results: result.items.map(r => ({
            name: r.full_name,
            description: r.description,
            language: r.language,
            stars: r.stargazers_count,
            url: r.html_url,
          })),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );
}
