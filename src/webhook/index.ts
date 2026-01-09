import OpenAI from 'openai';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import * as lambdaSdk from '@aws-sdk/client-lambda';
import { buildToolOutputs, extractFunctionCalls } from '../tools';

const lambda = new lambdaSdk.LambdaClient({});
const ssm = new SSMClient({});
let cachedWebhookSecret: string | null = null;

const DurableSuccessCommand = (lambdaSdk as any).SendDurableExecutionCallbackSuccessCommand;
const DurableFailureCommand = (lambdaSdk as any).SendDurableExecutionCallbackFailureCommand;

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function getRawBody(event: any) {
  if (!event || !event.body) return '';
  return event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
}

function normalizeHeaders(headers: Record<string, string> | null) {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

async function getWebhookSecret() {
  if (cachedWebhookSecret) return cachedWebhookSecret;

  const directSecret = process.env.OPENAI_WEBHOOK_SECRET;
  if (directSecret && directSecret.trim().length > 0) {
    cachedWebhookSecret = directSecret.trim();
    return cachedWebhookSecret;
  }

  const paramName = process.env.OPENAI_WEBHOOK_SECRET_PARAM;
  if (!paramName) {
    throw new Error('OPENAI_WEBHOOK_SECRET_PARAM is not set');
  }

  const response = await ssm.send(
    new GetParameterCommand({
      Name: paramName,
      WithDecryption: true,
    })
  );

  const value = response.Parameter?.Value;
  if (!value) {
    throw new Error('OPENAI_WEBHOOK_SECRET_PARAM is empty');
  }

  cachedWebhookSecret = value;
  return cachedWebhookSecret;
}

function ensureDurableCommands() {
  if (!DurableSuccessCommand || !DurableFailureCommand) {
    throw new Error(
      'Durable callback commands are unavailable. Update @aws-sdk/client-lambda to a recent version.'
    );
  }
}

async function sendDurableSuccess(callbackId: string, result: string) {
  ensureDurableCommands();

  const command = new DurableSuccessCommand({
    CallbackId: callbackId,
    Result: Buffer.from(result),
  });

  await lambda.send(command);
}

async function sendDurableFailure(
  callbackId: string,
  error: {
    type?: string;
    message?: string;
    data?: string;
    stack?: string;
  }
) {
  ensureDurableCommands();

  const command = new DurableFailureCommand({
    CallbackId: callbackId,
    ErrorType: error.type || 'WorkerError',
    ErrorMessage: error.message || 'Unknown error',
    ErrorData: error.data,
    StackTrace: error.stack ? [error.stack] : undefined,
  });

  await lambda.send(command);
}

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

async function retrieveResponse(responseId: string) {
  const url = buildAzureUrl(`responses/${encodeURIComponent(responseId)}`);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.AZURE_OPENAI_API_KEY || '',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure OpenAI retrieve error ${response.status}: ${text}`);
  }

  return response.json();
}

function extractCallbackId(responsePayload: any) {
  const metadata = responsePayload?.metadata;
  if (metadata && typeof metadata.callbackId === 'string') {
    return metadata.callbackId;
  }
  return null;
}

function getToolStep(metadata: any) {
  const raw = metadata?.toolStep;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function resolveModel(responsePayload: any) {
  return (
    responsePayload?.model ||
    process.env.AZURE_OPENAI_MODEL ||
    process.env.AZURE_OPENAI_DEPLOYMENT ||
    ''
  );
}

async function submitToolOutputs(params: {
  responseId: string;
  modelHint?: string;
  toolOutputs: Array<{ type: string; call_id: string; output: string }>;
  metadata: Record<string, unknown>;
}) {
  const model = resolveModel({ model: params.modelHint });
  if (!model) {
    throw new Error('AZURE_OPENAI_MODEL is not set');
  }

  const url = buildAzureUrl('responses');
  const body = {
    model,
    previous_response_id: params.responseId,
    input: params.toolOutputs,
    background: true,
    metadata: params.metadata,
  };

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
    throw new Error(`Azure OpenAI tool output error ${response.status}: ${text}`);
  }

  return response.json();
}

function isCallbackTimeoutError(err: any) {
  const name = typeof err?.name === 'string' ? err.name : '';
  const message = typeof err?.message === 'string' ? err.message : '';
  return name === 'CallbackTimeoutException' || message.includes('CallbackTimeoutException');
}

async function safeSendDurableSuccess(callbackId: string, result: string) {
  try {
    await sendDurableSuccess(callbackId, result);
    return true;
  } catch (err) {
    if (isCallbackTimeoutError(err)) {
      console.warn('durable callback already completed or timed out', {
        callbackId,
        reason: 'CallbackTimeoutException',
      });
      return false;
    }
    throw err;
  }
}

async function safeSendDurableFailure(
  callbackId: string,
  error: {
    type?: string;
    message?: string;
    data?: string;
    stack?: string;
  }
) {
  try {
    await sendDurableFailure(callbackId, error);
    return true;
  } catch (err) {
    if (isCallbackTimeoutError(err)) {
      console.warn('durable callback already completed or timed out', {
        callbackId,
        reason: 'CallbackTimeoutException',
      });
      return false;
    }
    throw err;
  }
}

export const handler = async (event: any) => {
  try {
    const webhookSecret = await getWebhookSecret();

    const rawBody = getRawBody(event);
    const headers = normalizeHeaders(event.headers ?? null);

    const webhookClient = new OpenAI({
      apiKey: 'placeholder',
      webhookSecret,
    });

    let webhookEvent: any;
    try {
      webhookEvent = webhookClient.webhooks.unwrap(rawBody, headers);
    } catch (err) {
      console.error('webhook signature verification failed', err);
      return jsonResponse(400, { error: 'Invalid webhook signature' });
    }

    console.log('webhook raw', rawBody);
    console.log('webhook event', JSON.stringify(webhookEvent, null, 2));

    let parsedRaw: any = null;
    if (typeof rawBody === 'string') {
      try {
        parsedRaw = JSON.parse(rawBody);
      } catch {
        parsedRaw = null;
      }
    } else {
      parsedRaw = rawBody;
    }

    const eventType = webhookEvent?.type ?? parsedRaw?.type;
    const responseId =
      webhookEvent?.data?.id ||
      webhookEvent?.data?.response?.id ||
      parsedRaw?.data?.id ||
      parsedRaw?.data?.response?.id;

    if (!responseId) {
      console.warn('No response id in webhook event', webhookEvent?.type);
      return jsonResponse(200, { status: 'ignored' });
    }

    const responsePayload = await retrieveResponse(responseId);
    const callbackId = extractCallbackId(responsePayload);

    if (!callbackId) {
      console.warn('callbackId missing in response metadata', responseId);
      return jsonResponse(200, { status: 'ignored' });
    }

    if (eventType && eventType !== 'response.completed') {
      const sent = await safeSendDurableFailure(callbackId, {
        type: eventType,
        message: responsePayload?.error?.message || 'Response not completed',
      });
      return jsonResponse(200, {
        status: sent ? 'failed' : 'ignored',
        reason: sent ? undefined : 'callback-timeout',
      });
    }

    const responseMetadata =
      responsePayload && typeof responsePayload.metadata === 'object' && responsePayload.metadata
        ? responsePayload.metadata
        : {};
    const toolStep = getToolStep(responseMetadata);
    const maxToolSteps = Number.parseInt(process.env.MAX_TOOL_STEPS || '5', 10);

    const functionCalls = extractFunctionCalls(responsePayload);
    if (functionCalls.length > 0) {
      if (toolStep >= maxToolSteps) {
        const sent = await safeSendDurableFailure(callbackId, {
          type: 'tool_loop',
          message: `Tool loop exceeded MAX_TOOL_STEPS=${maxToolSteps}`,
        });
        return jsonResponse(200, {
          status: sent ? 'failed' : 'ignored',
          reason: sent ? 'tool-loop' : 'callback-timeout',
        });
      }

      const { outputs: toolOutputs, unknown } = buildToolOutputs(functionCalls);
      for (const call of unknown) {
        console.warn('Unknown tool call', { name: call?.name, callId: call?.call_id });
      }

      if (toolOutputs.length === 0) {
        const sent = await safeSendDurableFailure(callbackId, {
          type: 'tool_call',
          message: 'No supported tool calls found in response.',
        });
        return jsonResponse(200, {
          status: sent ? 'failed' : 'ignored',
          reason: sent ? 'unsupported-tool' : 'callback-timeout',
        });
      }

      const nextMetadata = {
        ...responseMetadata,
        callbackId,
        toolStep: String(toolStep + 1),
      } as Record<string, unknown>;

      const nextResponse = await submitToolOutputs({
        responseId: responsePayload?.id || responseId,
        modelHint: responsePayload?.model,
        toolOutputs,
        metadata: nextMetadata,
      });

      console.log('tool outputs submitted', {
        responseId: responsePayload?.id || responseId,
        nextResponseId: nextResponse?.id,
        toolCalls: toolOutputs.length,
      });

      return jsonResponse(200, { status: 'tool-output-submitted', toolCalls: toolOutputs.length });
    }

    const result = JSON.stringify({
      response: responsePayload,
      metadata: responsePayload?.metadata ?? null,
    });

    const sent = await safeSendDurableSuccess(callbackId, result);
    return jsonResponse(200, {
      status: sent ? 'ok' : 'ignored',
      reason: sent ? undefined : 'callback-timeout',
    });
  } catch (err) {
    console.error('webhook handler error', err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
};
