import * as path from 'path';
import { Duration, CfnOutput, CustomResource, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';

export class DurableLambdaGptStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const requireEnv = (name: string) => {
      const value = process.env[name];
      if (!value || value.trim().length === 0) {
        throw new Error(`Missing required env var: ${name}`);
      }
      return value;
    };

    const azureOpenAIEndpoint = requireEnv('AZURE_OPENAI_ENDPOINT');
    const azureOpenAIApiKey = requireEnv('AZURE_OPENAI_API_KEY');
    const azureOpenAIModel =
      process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT;
    if (!azureOpenAIModel || azureOpenAIModel.trim().length === 0) {
      throw new Error('Missing required env var: AZURE_OPENAI_MODEL');
    }
    const azureOpenAIApiVersion = process.env.AZURE_OPENAI_API_VERSION || '';
    const invokeApiKeyValue = requireEnv('INVOKE_API_KEY');

    const durableExecutionTimeout = Number.parseInt(
      process.env.DURABLE_EXECUTION_TIMEOUT || '900',
      10
    );
    const durableRetentionDays = Number.parseInt(
      process.env.DURABLE_RETENTION_DAYS || '14',
      10
    );

    const api = new apigateway.RestApi(this, 'Api', {
      deployOptions: {
        stageName: 'Prod',
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Api-Key',
          'Webhook-Id',
          'Webhook-Timestamp',
          'Webhook-Signature',
        ],
      },
    });

    const runtime = new lambda.Runtime('nodejs22.x', lambda.RuntimeFamily.NODEJS);

    const bundling: nodejs.BundlingOptions = {
      target: 'node22',
      // Bundle AWS SDK v3 so we can use the latest client-lambda commands
      externalModules: ['aws-sdk'],
    };

    const invokeApiKey = api.addApiKey('InvokeApiKey', {
      apiKeyName: 'DurableLambdaInvokeKey',
      value: invokeApiKeyValue,
    });

    const usagePlan = api.addUsagePlan('InvokeUsagePlan', {
      name: 'DurableLambdaInvokePlan',
      apiStages: [{ api, stage: api.deploymentStage }],
      throttle: {
        rateLimit: 5,
        burstLimit: 10,
      },
      quota: {
        limit: 1000,
        period: apigateway.Period.DAY,
      },
    });

    usagePlan.addApiKey(invokeApiKey);

    const webhookSecretParamName = `/durable-lambda-gpt/${this.stackName}/openai-webhook-secret`;

    const workerFunction = new nodejs.NodejsFunction(this, 'WorkerFunction', {
      runtime,
      entry: path.join(__dirname, '../src/worker/index.ts'),
      handler: 'handler',
      timeout: Duration.seconds(60),
      bundling,
      environment: {
        AZURE_OPENAI_ENDPOINT: azureOpenAIEndpoint,
        AZURE_OPENAI_API_KEY: azureOpenAIApiKey,
        AZURE_OPENAI_MODEL: azureOpenAIModel,
        AZURE_OPENAI_API_VERSION: azureOpenAIApiVersion,
      },
    });

    const maxToolSteps = process.env.MAX_TOOL_STEPS;

    const webhookReceiverFunction = new nodejs.NodejsFunction(
      this,
      'WebhookReceiverFunction',
      {
        runtime,
        entry: path.join(__dirname, '../src/webhook/index.ts'),
        handler: 'handler',
        bundling,
        environment: {
          AZURE_OPENAI_ENDPOINT: azureOpenAIEndpoint,
          AZURE_OPENAI_API_KEY: azureOpenAIApiKey,
          AZURE_OPENAI_MODEL: azureOpenAIModel,
          AZURE_OPENAI_API_VERSION: azureOpenAIApiVersion,
          OPENAI_WEBHOOK_SECRET_PARAM: webhookSecretParamName,
          ...(maxToolSteps ? { MAX_TOOL_STEPS: maxToolSteps } : {}),
        },
      }
    );

    const webhookProvisionerFunction = new nodejs.NodejsFunction(
      this,
      'WebhookProvisionerFunction',
      {
        runtime,
        entry: path.join(__dirname, '../src/provisioner/index.ts'),
        handler: 'handler',
        timeout: Duration.seconds(30),
        bundling,
        environment: {
          AZURE_OPENAI_ENDPOINT: azureOpenAIEndpoint,
          AZURE_OPENAI_API_KEY: azureOpenAIApiKey,
          AZURE_OPENAI_API_VERSION: azureOpenAIApiVersion,
          WEBHOOK_SECRET_PARAM_NAME: webhookSecretParamName,
        },
      }
    );

    // Using any as a workaround if types are not perfectly updated in the simulation environment
    // to support durableConfig property on NodejsFunction directly if strictly typed.
    // However, in 2026 this should be standard.
    const durableFunction = new nodejs.NodejsFunction(this, 'DurableFunction', {
      runtime,
      entry: path.join(__dirname, '../src/durable/index.ts'),
      handler: 'handler',
      bundling,
      // @ts-ignore - Assuming durableConfig is the new property
      durableConfig: {
        executionTimeout: Duration.seconds(durableExecutionTimeout),
        retentionPeriod: Duration.days(durableRetentionDays),
      },
      environment: {
        WORKER_FUNCTION_NAME: workerFunction.functionName,
      },
    });

    // Grant permissions
    // Note: 'lambda:ManageDurableState' etc might be grouped under a managed policy or specific actions.
    durableFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'lambda:ManageDurableState',
          'lambda:GetDurableExecution',
          'lambda:ListDurableExecutions',
          'lambda:InvokeFunction',
          'lambda:GetFunction',
        ],
        resources: ['*'],
      })
    );

    workerFunction.grantInvoke(durableFunction);

    webhookReceiverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'lambda:SendDurableExecutionCallbackSuccess',
          'lambda:SendDurableExecutionCallbackFailure',
        ],
        resources: ['*'],
      })
    );

    webhookReceiverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${webhookSecretParamName}`,
        ],
      })
    );

    webhookProvisionerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${webhookSecretParamName}`,
        ],
      })
    );

    const invokeResource = api.root.addResource('invoke');
    invokeResource.addMethod('POST', new apigateway.LambdaIntegration(durableFunction), {
      apiKeyRequired: true,
    });

    const webhookResource = api.root.addResource('webhook');
    webhookResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(webhookReceiverFunction)
    );

    const webhookProvider = new cr.Provider(this, 'WebhookProvisionerProvider', {
      onEventHandler: webhookProvisionerFunction,
    });

    new CustomResource(this, 'AzureOpenAIWebhook', {
      serviceToken: webhookProvider.serviceToken,
      properties: {
        WebhookUrl: api.urlForPath('/webhook'),
        WebhookName: `durable-lambda-gpt-${this.stackName}`,
        EventTypes: ['response.completed', 'response.failed', 'response.incomplete'],
      },
    });

    new CfnOutput(this, 'ApiBaseUrl', {
      value: api.url,
    });

    new CfnOutput(this, 'InvokeUrl', {
      value: api.urlForPath('/invoke'),
    });

    new CfnOutput(this, 'WebhookUrl', {
      value: api.urlForPath('/webhook'),
    });

    new CfnOutput(this, 'WebhookSecretParam', {
      value: webhookSecretParamName,
    });
  }
}
