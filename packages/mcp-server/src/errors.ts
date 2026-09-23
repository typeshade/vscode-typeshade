// === The one kind of failure the agent is meant to read ===

/**
 * A failure the agent caused and can fix: a path outside the workspace, a function the module
 * does not declare, a position past the end of a line.
 *
 * The server reports it as the tool's own result with `isError` set rather than as a protocol
 * error, because MCP clients hand a tool result to the model and a protocol error to the user:
 * the sentence has to reach whoever can act on it. Anything else that throws is a bug in the
 * server, and is reported the same way but labelled as one.
 */
export class ToolError extends Error {
  override readonly name = 'ToolError';
}
