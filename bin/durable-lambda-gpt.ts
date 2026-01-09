#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import dotenv from 'dotenv';
import { DurableLambdaGptStack } from '../lib/durable-lambda-gpt-stack';

dotenv.config();

const app = new cdk.App();

new DurableLambdaGptStack(app, 'DurableLambdaGptStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-2',
  },
});
