import type { ToolHandler } from './types';

function parseJsonValue(value: unknown) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function rollDice(sides: number) {
  const safeSides = Number.isFinite(sides) && sides > 1 ? Math.floor(sides) : 6;
  return 1 + Math.floor(Math.random() * safeSides);
}

export const rollDiceTool: ToolHandler = {
  definition: {
    type: 'function',
    name: 'roll_dice',
    description: 'Roll a dice with the given number of sides.',
    parameters: {
      type: 'object',
      properties: {
        sides: {
          type: 'integer',
          description: 'Number of sides for the dice. Defaults to 6.',
        },
      },
      required: [],
    },
  },
  execute: ({ callId, arguments: args }) => {
    const parsedArgs = parseJsonValue(args) as any;
    const sides = Number(parsedArgs?.sides ?? 6);
    const safeSides = Number.isFinite(sides) ? Math.floor(sides) : 6;
    const roll = rollDice(safeSides);
    return {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({ sides: safeSides, roll }),
    };
  },
};
