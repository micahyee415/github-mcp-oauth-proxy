import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitHubClient, GitHubError } from "../github-client.js";

function toolError(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerIssueTools(server: McpServer, client: GitHubClient): void {
  server.tool(
    "list_issues",
    "List issues for a GitHub repository. Excludes pull requests (use list_pull_requests for those).",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      state: z.enum(["open", "closed", "all"]).optional().describe("Issue state (default: open)"),
      per_page: z.number().optional().describe("Results per page (1–100, default 30)"),
      page: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ owner, repo, state, per_page, page }) => {
      try {
        const issues = await client.listIssues(owner, repo, { state, per_page, page });
        // Filter out pull requests (GitHub API includes them in issues endpoint)
        const realIssues = issues.filter(i => !i.pull_request);
        const summary = realIssues.map(i => ({
          number: i.number,
          title: i.title,
          state: i.state,
          author: i.user?.login,
          labels: i.labels.map(l => l.name),
          created_at: i.created_at,
          updated_at: i.updated_at,
          url: i.html_url,
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return toolError(`Repository ${owner}/${repo} not found.`);
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_issue",
    "Get the full details and comments for a specific GitHub issue.",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      issue_number: z.number().describe("Issue number"),
    },
    async ({ owner, repo, issue_number }) => {
      try {
        const [issue, comments] = await Promise.all([
          client.getIssue(owner, repo, issue_number),
          client.listIssueComments(owner, repo, issue_number),
        ]);
        const result = {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          author: issue.user?.login,
          body: issue.body,
          labels: issue.labels.map(l => l.name),
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          url: issue.html_url,
          comments: comments.map(c => ({
            author: c.user?.login,
            body: c.body,
            created_at: c.created_at,
          })),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return toolError(`Issue #${issue_number} not found in ${owner}/${repo}.`);
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );

  server.tool(
    "search_issues",
    "Search GitHub issues and pull requests using GitHub's search syntax. Examples: 'bug repo:your-org/your-repo is:open', 'label:bug is:closed'",
    {
      query: z.string().describe("GitHub issue search query (supports is:, label:, repo:, author: qualifiers)"),
      per_page: z.number().optional().describe("Results per page (1–30, default 20)"),
    },
    async ({ query, per_page }) => {
      try {
        const result = await client.searchIssues(query, per_page ?? 20);
        const summary = {
          total_count: result.total_count,
          results: result.items.map(i => ({
            number: i.number,
            title: i.title,
            state: i.state,
            type: i.pull_request ? "pull_request" : "issue",
            author: i.user?.login,
            labels: i.labels.map(l => l.name),
            url: i.html_url,
          })),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );
}
