import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerFileTools } from "./tools/files.js";
import { registerClaudeTaskTool } from "./tools/claude-task.js";

/** One MCP server instance per session (transport lifecycle owns it). */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "home-bridge", version: "0.1.0" },
    {
      instructions:
        "Bridge to Filip's home server. Use get_memory_index + search_memory + read_memory to learn how this " +
        "server and its projects work (infra, runbooks, conventions like trip field-guide PDFs). Use list_files/" +
        "read_file/write_file for Nextcloud data. Use run_claude_task to actually run or render things on the box.",
    },
  );

  registerMemoryTools(server);
  registerFileTools(server);
  registerClaudeTaskTool(server);

  return server;
}
