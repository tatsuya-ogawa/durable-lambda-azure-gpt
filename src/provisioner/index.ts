import https from 'https';
import { URL } from 'url';
import { SSMClient, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

type CloudFormationEvent = {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceProperties: Record<string, any>;
  OldResourceProperties?: Record<string, any>;
};

type CloudFormationContext = {
  logStreamName: string;
};

function getAzureBaseUrl(endpoint: string) {
  const trimmed = endpoint.replace(/\/+$/, '');
  if (trimmed.includes('/responses') || trimmed.includes('/chat/completions')) {
    throw new Error('AZURE_OPENAI_ENDPOINT must be a base URL without path');
  }
  if (trimmed.includes('/openai/')) {
    return trimmed;
  }
  return `${trimmed}/openai/v1`;
}

function buildAzureUrl(base: string, path: string, apiVersion?: string) {
  const url = new URL(`${base}/${path}`);
  const shouldAddVersion =
    !!apiVersion && !base.includes('/openai/v1') && !path.startsWith('dashboard/');
  if (shouldAddVersion) {
    url.searchParams.set('api-version', apiVersion);
  }
  return url.toString();
}

async function requestAzure(
  method: string,
  url: string,
  apiKey: string,
  body?: Record<string, unknown>
) {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure webhook API error ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json().catch(() => null);
}

async function sendResponse(
  event: CloudFormationEvent,
  context: CloudFormationContext,
  status: 'SUCCESS' | 'FAILED',
  data: Record<string, unknown>,
  physicalResourceId: string,
  reason?: string
) {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: reason || `See CloudWatch Log Stream: ${context.logStreamName}`,
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });

  const responseUrl = new URL(event.ResponseURL);

  await new Promise<void>((resolve, reject) => {
    const request = https.request(
      {
        hostname: responseUrl.hostname,
        path: responseUrl.pathname + responseUrl.search,
        method: 'PUT',
        headers: {
          'content-type': '',
          'content-length': Buffer.byteLength(responseBody),
        },
      },
      (response) => {
        response.on('data', () => undefined);
        response.on('end', resolve);
      }
    );

    request.on('error', reject);
    request.write(responseBody);
    request.end();
  });
}

async function upsertWebhook(props: Record<string, any>, webhookId?: string) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
  const apiKey = process.env.AZURE_OPENAI_API_KEY || '';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '';
  const parameterName = process.env.WEBHOOK_SECRET_PARAM_NAME || '';

  if (!endpoint || !apiKey || !parameterName) {
    throw new Error('Missing required environment variables for webhook provisioner');
  }

  const base = getAzureBaseUrl(endpoint);
  const events: string[] = Array.isArray(props.EventTypes)
    ? props.EventTypes
    : ['response.completed', 'response.failed', 'response.incomplete'];

  if (webhookId) {
    const updateUrl = buildAzureUrl(
      base,
      `dashboard/webhook_endpoints/${webhookId}`,
      apiVersion
    );
    try {
      await requestAzure('POST', updateUrl, apiKey, {
        url: props.WebhookUrl,
        name: props.WebhookName,
        event_types: events,
      });

      return { id: webhookId, signingSecret: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (!message.includes('404')) {
        throw err;
      }
    }
  }

  const createUrl = buildAzureUrl(base, 'dashboard/webhook_endpoints', apiVersion);
  const result = await requestAzure('POST', createUrl, apiKey, {
    url: props.WebhookUrl,
    name: props.WebhookName,
    event_types: events,
  });

  const signingSecret = result?.signing_secret;
  if (!signingSecret) {
    throw new Error('Azure webhook did not return signing_secret');
  }

  await ssm.send(
    new PutParameterCommand({
      Name: parameterName,
      Type: 'SecureString',
      Value: signingSecret,
      Overwrite: true,
    })
  );

  return { id: result.id || props.WebhookName, signingSecret };
}

async function deleteWebhook(webhookId: string) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || '';
  const apiKey = process.env.AZURE_OPENAI_API_KEY || '';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '';

  if (!endpoint || !apiKey) {
    throw new Error('Missing required environment variables for webhook provisioner');
  }

  const base = getAzureBaseUrl(endpoint);
  const deleteUrl = buildAzureUrl(base, `dashboard/webhook_endpoints/${webhookId}`, apiVersion);

  try {
    await requestAzure('DELETE', deleteUrl, apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('404')) {
      return;
    }
    throw err;
  }
}

async function deleteSecret() {
  const parameterName = process.env.WEBHOOK_SECRET_PARAM_NAME || '';
  if (!parameterName) {
    return;
  }

  try {
    await ssm.send(
      new DeleteParameterCommand({
        Name: parameterName,
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('ParameterNotFound')) {
      return;
    }
    throw err;
  }
}

export const handler = async (event: CloudFormationEvent, context: CloudFormationContext) => {
  console.log('Webhook provisioner event', JSON.stringify(event, null, 2));

  const physicalId = event.PhysicalResourceId || 'azure-openai-webhook';

  try {
    if (event.RequestType === 'Delete') {
      if (event.PhysicalResourceId && event.PhysicalResourceId !== 'azure-openai-webhook') {
        await deleteWebhook(event.PhysicalResourceId);
      }
      await deleteSecret();
      await sendResponse(event, context, 'SUCCESS', { status: 'deleted' }, physicalId);
      return;
    }

    if (event.RequestType === 'Create') {
      const result = await upsertWebhook(event.ResourceProperties);
      const nextId = result.id || physicalId;
      await sendResponse(
        event,
        context,
        'SUCCESS',
        { webhookId: result.id || nextId },
        nextId
      );
      return;
    }

    const oldProps = event.OldResourceProperties || {};
    const newProps = event.ResourceProperties || {};

    const changed =
      oldProps.WebhookUrl !== newProps.WebhookUrl ||
      JSON.stringify(oldProps.EventTypes) !== JSON.stringify(newProps.EventTypes) ||
      oldProps.WebhookName !== newProps.WebhookName;

    if (!changed) {
      await sendResponse(event, context, 'SUCCESS', { status: 'unchanged' }, physicalId);
      return;
    }

    const result = await upsertWebhook(newProps, event.PhysicalResourceId);
    const nextId = result.id || physicalId;
    await sendResponse(
      event,
      context,
      'SUCCESS',
      { webhookId: result.id || nextId },
      nextId
    );
  } catch (err) {
    console.error('Webhook provisioner error', err);
    await sendResponse(
      event,
      context,
      'FAILED',
      { error: err instanceof Error ? err.message : 'Unknown error' },
      physicalId,
      err instanceof Error ? err.message : 'Unknown error'
    );
  }
};
