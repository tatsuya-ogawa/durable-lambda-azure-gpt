export type ToolDefinition = {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type ToolCall = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: unknown;
};

export type ToolOutput = {
  type: 'function_call_output';
  call_id: string;
  output: string;
};

export type ToolHandler = {
  definition: ToolDefinition;
  execute: (input: { callId: string; arguments: unknown }) => ToolOutput | null;
};
