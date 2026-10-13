export {
  McpConfigError,
  McpConnectionError,
} from './types.ts'
export type {
  McpClient,
  McpConnection,
  McpServerConfig,
  McpToolCallResult,
  McpToolDefinition,
} from './types.ts'
export { connectMcpServers, parseMcpServerConfigs } from './connect.ts'
export type { McpConnections, McpToolWithServer } from './connect.ts'
export { HttpMcpClient } from './http.ts'
export { StdioMcpClient } from './stdio.ts'
export {
  asConnectionError,
  decodeMessage,
  encodeNotification,
  encodeRequest,
  LineSplitter,
  McpProtocolError,
  unwrapResult,
} from './jsonrpc.ts'
export type { DecodedMessage } from './jsonrpc.ts'
export {
  buildMcpCallTool,
  buildPromptSection,
  buildToolSearchTool,
  CHARS_PER_TOKEN,
  decideExposureMode,
  DEFAULT_EAGER_THRESHOLD_PERCENT,
  MAX_SEARCH_RESULTS,
  MCP_PROMPT_FRAGMENT,
  MCP_TOOL_CALL,
  MCP_TOOL_SEARCH,
  MCP_TOOL_SOURCE,
  mcpToolSchemaChars,
  mountMcpExposure,
  planMcpExposure,
  qualifiedToolName,
  searchTools,
} from './expose.ts'
export type { McpExposureMode, McpExposurePlan } from './expose.ts'
export { buildMcpConfig, withMcpTools } from './expose.ts'
export type { McpMountOptions, McpRecipeConfig, McpServerSummary } from './expose.ts'
