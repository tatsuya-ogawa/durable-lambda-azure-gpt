import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function parsePayload(event: any) {
  if (!event) return null;
  if (typeof event.body === 'string') {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof event === 'object') {
    return event;
  }
  return null;
}

function normalizeMessages(payload: any) {
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    return payload.messages;
  }
  if (typeof payload.prompt !== 'string' || payload.prompt.trim().length === 0) {
    return null;
  }
  const systemPrompt =
    typeof payload.systemPrompt === 'string' && payload.systemPrompt.trim().length > 0
      ? payload.systemPrompt
      : 'You are a helpful assistant.';

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: payload.prompt },
  ];
}

async function invokeWorker(payload: Record<string, unknown>) {
  const functionName = process.env.WORKER_FUNCTION_NAME || '';
  if (!functionName) {
    throw new Error('WORKER_FUNCTION_NAME is not set');
  }

  const command = new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify(payload)),
  });

  await lambda.send(command);
}

export const handler = withDurableExecution(
  async (event: any, context: DurableContext) => {
    const payload = parsePayload(event);
    if (!payload) {
      return jsonResponse(400, { error: 'Invalid JSON body' });
    }

    const messages = normalizeMessages(payload);
    if (!messages) {
      return jsonResponse(400, { error: 'prompt or messages is required' });
    }

    const request: Record<string, unknown> = { messages };
    if (typeof payload.temperature === 'number') {
      request.temperature = payload.temperature;
    }
    if (typeof payload.maxTokens === 'number') {
      request.maxTokens = payload.maxTokens;
    }
    if (typeof payload.toolChoice !== 'undefined') {
      request.toolChoice = payload.toolChoice;
    }
    if (typeof payload.instructions === 'string' && payload.instructions.trim().length > 0) {
      request.instructions = payload.instructions.trim();
    }

    const [callbackPromise, callbackId] = await context.createCallback(
      'gpt-webhook',
      {
        timeout: { minutes: 10 },
      }
    );

    await context.step('invoke-worker', async () => {
      await invokeWorker({
        callbackId,
        request,
        metadata: payload.metadata ?? null,
      });
    });

    const result = await callbackPromise;

    let parsedResult = result;
    if (typeof result === 'string') {
      try {
        parsedResult = JSON.parse(result);
      } catch {
        parsedResult = { raw: result };
      }
    }

    return jsonResponse(200, { status: 'ok', result: parsedResult });
  }
);
