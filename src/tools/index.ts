import type { ToolCall, ToolHandler, ToolOutput } from './types';
import { rollDiceTool } from './rollDice';

const TOOL_HANDLERS: ToolHandler[] = [rollDiceTool];

export function buildTools() {
  return TOOL_HANDLERS.map((tool) => tool.definition);
}

export function extractFunctionCalls(responsePayload: any): ToolCall[] {
  const output = responsePayload?.output;
  if (!Array.isArray(output)) return [];
  return output.filter((item) => item && item.type === 'function_call');
}

export function buildToolOutputs(calls: ToolCall[]) {
  const outputs: ToolOutput[] = [];
  const unknown: ToolCall[] = [];

  for (const call of calls) {
    const name = call?.name;
    const callId = call?.call_id;
    if (!name || !callId) {
      continue;
    }

    const handler = TOOL_HANDLERS.find((tool) => tool.definition.name === name);
    if (!handler) {
      unknown.push(call);
      continue;
    }

    const output = handler.execute({ callId, arguments: call.arguments });
    if (output) {
      outputs.push(output);
    }
  }

  return { outputs, unknown };
}
