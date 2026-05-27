import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitHubClient, GitHubError } from "../github-client.js";

function toolError(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerPRTools(server: McpServer, client: GitHubClient): void {
  server.tool(
    "list_pull_requests",
    "List pull requests for a GitHub repository.",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      state: z.enum(["open", "closed", "all"]).optional().describe("PR state (default: open)"),
      per_page: z.number().optional().describe("Results per page (1–100, default 30)"),
      page: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ owner, repo, state, per_page, page }) => {
      try {
        const prs = await client.listPullRequests(owner, repo, { state, per_page, page });
        const summary = prs.map(pr => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.user?.login,
          base: pr.base.ref,
          head: pr.head.ref,
          merged: pr.merged,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          url: pr.html_url,
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return toolError(`Repository ${owner}/${repo} not found.`);
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_pull_request",
    "Get full details of a pull request including its description and changed file summary.",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
    },
    async ({ owner, repo, pull_number }) => {
      try {
        const pr = await client.getPullRequest(owner, repo, pull_number);
        const result = {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          merged: pr.merged,
          author: pr.user?.login,
          body: pr.body,
          base: pr.base.ref,
          head: { branch: pr.head.ref, sha: pr.head.sha },
          stats: {
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changed_files,
          },
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          url: pr.html_url,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return toolError(`PR #${pull_number} not found in ${owner}/${repo}.`);
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );

  server.tool(
    "list_pr_files",
    "List files changed in a pull request, including diffs (patches) for each file.",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      pull_number: z.number().describe("Pull request number"),
      include_patch: z.boolean().optional().describe("Include the diff patch for each file (default true)"),
    },
    async ({ owner, repo, pull_number, include_patch = true }) => {
      try {
        const files = await client.listPRFiles(owner, repo, pull_number);
        const result = files.map(f => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          ...(include_patch && f.patch ? { patch: f.patch } : {}),
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return toolError(`PR #${pull_number} not found in ${owner}/${repo}.`);
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );
}
