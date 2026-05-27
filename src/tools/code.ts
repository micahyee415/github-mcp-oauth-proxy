import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitHubClient, GitHubError, GHContent } from "../github-client.js";

function toolError(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerCodeTools(server: McpServer, client: GitHubClient): void {
  server.tool(
    "get_file_contents",
    "Get the contents of a file from a GitHub repository.",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      path: z.string().describe("File path within the repository (e.g. 'src/index.ts')"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo's default branch)"),
    },
    async ({ owner, repo, path, ref }) => {
      try {
        const content = await client.getContents(owner, repo, path, ref);
        if (Array.isArray(content)) {
          return toolError(`'${path}' is a directory. Use list_directory to browse it.`);
        }
        if (content.type !== "file") {
          return toolError(`'${path}' is not a file (type: ${content.type}).`);
        }
        if (!content.content || content.encoding !== "base64") {
          return toolError("File content is not available or not base64 encoded.");
        }
        // Decode base64 content (GitHub includes newlines in the base64 string)
        const decoded = Buffer.from(content.content.replace(/\n/g, ""), "base64").toString("utf-8");
        return {
          content: [{ type: "text" as const, text: decoded }],
        };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return toolError(`File not found: ${owner}/${repo}/${path}`);
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );

  server.tool(
    "list_directory",
    "List files and subdirectories at a path in a GitHub repository.",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      path: z.string().optional().describe("Directory path (default: repo root)"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo's default branch)"),
    },
    async ({ owner, repo, path = "", ref }) => {
      try {
        const contents = await client.getContents(owner, repo, path, ref);
        if (!Array.isArray(contents)) {
          return toolError(`'${path || "/"}' is a file. Use get_file_contents to read it.`);
        }
        const entries = (contents as GHContent[]).map(item => ({
          name: item.name,
          type: item.type,
          path: item.path,
          size: item.type === "file" ? item.size : undefined,
        }));
        // Sort: directories first, then files
        entries.sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === "dir" ? -1 : 1;
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return toolError(`Path not found: ${owner}/${repo}/${path}`);
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );

  server.tool(
    "search_code",
    "Search code across GitHub repositories. Use repo: qualifier to scope to a specific repo. Examples: 'useState repo:your-org/your-repo', 'function authenticate language:typescript'",
    {
      query: z.string().describe("Code search query (supports repo:, language:, path:, filename: qualifiers)"),
      per_page: z.number().optional().describe("Results per page (1–30, default 20)"),
    },
    async ({ query, per_page }) => {
      try {
        const result = await client.searchCode(query, per_page ?? 20);
        const summary = {
          total_count: result.total_count,
          results: result.items.map(item => ({
            repository: item.repository.full_name,
            path: item.path,
            name: item.name,
            url: item.html_url,
          })),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 422) {
          return toolError("Search query is invalid. Try adding a repo: qualifier or simplifying your query.");
        }
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );

  server.tool(
    "list_commits",
    "List recent commits for a repository or a specific file path.",
    {
      owner: z.string().describe("Repository owner"),
      repo: z.string().describe("Repository name"),
      branch: z.string().optional().describe("Branch or commit SHA to start from (default: default branch)"),
      path: z.string().optional().describe("Only show commits that changed this file/directory"),
      per_page: z.number().optional().describe("Results per page (1–100, default 20)"),
      page: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ owner, repo, branch, path, per_page, page }) => {
      try {
        const commits = await client.listCommits(owner, repo, {
          sha: branch,
          path,
          per_page: per_page ?? 20,
          page: page ?? 1,
        });
        const summary = commits.map(c => ({
          sha: c.sha.slice(0, 7),
          message: c.commit.message.split("\n")[0], // first line only
          author: c.commit.author?.name,
          date: c.commit.author?.date,
          url: c.html_url,
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return toolError(`Repository ${owner}/${repo} not found.`);
        return toolError(err instanceof GitHubError ? err.message : String(err));
      }
    }
  );
}
