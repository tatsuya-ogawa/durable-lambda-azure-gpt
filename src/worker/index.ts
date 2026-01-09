// Durable Lambda invokes this worker with:
// { callbackId: "...", request: { ... }, metadata: ... }

import { buildTools } from '../tools';

function getAzureBaseUrl() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
  if (!endpoint) {
    throw new Error('AZURE_OPENAI_ENDPOINT is not set');
  }
  const trimmed = endpoint.replace(/\/+$/, '');
  if (trimmed.includes('/responses') || trimmed.includes('/chat/completions')) {
    throw new Error('AZURE_OPENAI_ENDPOINT must be a base URL without path');
  }
  if (trimmed.includes('/openai/')) {
    return trimmed;
  }
  return `${trimmed}/openai/v1`;
}

function buildAzureUrl(path: string) {
  const base = getAzureBaseUrl();
  const url = new URL(`${base}/${path}`);
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '';
  if (apiVersion && !base.includes('/openai/v1')) {
    url.searchParams.set('api-version', apiVersion);
  }
  return url.toString();
}

function toResponsesInput(messages: any[]) {
  return messages.map((message) => {
    if (Array.isArray(message.content)) {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: [
        {
          type: 'input_text',
          text: String(message.content ?? ''),
        },
      ],
    };
  });
}

function buildResponsesBody(event: any) {
  const model =
    process.env.AZURE_OPENAI_MODEL ||
    process.env.AZURE_OPENAI_DEPLOYMENT ||
    '';
  if (!model) {
    throw new Error('AZURE_OPENAI_MODEL is not set');
  }

  const request = event.request || {};
  let input: any = request.input;

  if (!input && Array.isArray(request.messages)) {
    input = toResponsesInput(request.messages);
  }
  if (!input && typeof request.prompt === 'string') {
    input = request.prompt;
  }
  if (!input) {
    throw new Error('request.messages or request.prompt is required');
  }

  const extraMetadata =
    event.metadata && typeof event.metadata === 'object' ? event.metadata : {};

  const body: Record<string, unknown> = {
    model,
    input,
    background: true,
    metadata: {
      callbackId: event.callbackId,
      ...extraMetadata,
    },
  };

  body.tools = buildTools();
  const metadata = body.metadata as Record<string, unknown>;
  if (typeof metadata.toolStep !== 'string') {
    metadata.toolStep = '0';
  }

  if (typeof request.temperature === 'number') {
    body.temperature = request.temperature;
  }
  if (typeof request.maxTokens === 'number') {
    body.max_output_tokens = request.maxTokens;
  }
  if (typeof request.toolChoice !== 'undefined') {
    body.tool_choice = request.toolChoice;
  }
  if (typeof request.instructions === 'string' && request.instructions.trim().length > 0) {
    body.instructions = request.instructions.trim();
  }

  return body;
}

async function createBackgroundResponse(event: any) {
  const url = buildAzureUrl('responses');
  const body = buildResponsesBody(event);

  console.log('Calling Azure OpenAI responses.create', url);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.AZURE_OPENAI_API_KEY || '',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure OpenAI error ${response.status}: ${text}`);
  }

  return response.json();
}

export const handler = async (event: any) => {
  console.log('Worker invoked', JSON.stringify(event, null, 2));

  const callbackId = event.callbackId;
  if (!callbackId) {
    throw new Error('callbackId is required');
  }

  const result = await createBackgroundResponse(event);
  console.log('Response created', { id: result.id, status: result.status });

  return { status: 'accepted', responseId: result.id };
};
