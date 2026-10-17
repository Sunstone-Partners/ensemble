/**
 * Cloud axis of detect-stack: the 20 sample-project scenarios of the former
 * cloud-provider-detector test script, run through `detect('cloud', ...)`.
 *
 * The original script asserted detection from a single signal at the default
 * 0.7 threshold. The scoring it ran against cannot do that: confidence is the
 * detected signal weight divided by the total weight of all signals (1.8), so
 * one Terraform signal scores 0.5 / 1.8 = 0.278, and only entries with at
 * least 3 signals reach the +0.3 boost. That scoring is unchanged by the
 * merge, and the original script already failed 42 of its 59 assertions
 * against it. These tests therefore keep each scenario's intent (the right
 * provider is attributed through the right signal) and:
 *
 * - run single-signal scenarios with a threshold below the signal's score
 *   (SINGLE_SIGNAL) and assert the exact confidence, which pins the weights;
 * - assert the real default-threshold behaviour in "Scoring" so a future
 *   change to it shows up as a failing test instead of a silent shift.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { detect } = require('../detect-stack');

const created = [];

/** Create a throwaway project directory containing { relativePath: content }. */
function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-stack-cloud-'));
  created.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return dir;
}

afterAll(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Signal weights from patterns/cloud.json, and their sum.
const WEIGHT = { terraform: 0.5, npm: 0.3, python: 0.3, cli: 0.2, docker: 0.2, config: 0.3 };
const TOTAL_WEIGHT = 1.8;
const BOOST = 0.3; // per-provider confidence_boost, applied from 3 signals

// Lower than every single-signal score (smallest: 0.2 / 1.8 = 0.111).
const SINGLE_SIGNAL = { minimumConfidence: 0.1 };

const topCandidate = result => result.all_results[0];

describe('cloud axis', () => {
  test('1. AWS via Terraform', async () => {
    const dir = makeProject({
      'main.tf': `
        provider "aws" {
          region = "us-east-1"
        }

        resource "aws_vpc" "main" {
          cidr_block = "10.0.0.0/16"
        }

        resource "aws_s3_bucket" "data" {
          bucket = "my-data-bucket"
        }
      `
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('aws');
    expect(result.confidence).toBeCloseTo(WEIGHT.terraform / TOTAL_WEIGHT, 5);
    expect(result.results[0].signals.terraform).toBe(true);
  });

  test('2. GCP via Terraform', async () => {
    const dir = makeProject({
      'main.tf': `
        provider "google" {
          project = "my-gcp-project"
          region  = "us-central1"
        }

        resource "google_compute_instance" "vm" {
          name         = "test-vm"
          machine_type = "n1-standard-1"
        }

        resource "google_storage_bucket" "data" {
          name     = "my-data-bucket"
          location = "US"
        }
      `
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('gcp');
    expect(result.confidence).toBeCloseTo(WEIGHT.terraform / TOTAL_WEIGHT, 5);
    expect(result.results[0].signals.terraform).toBe(true);
  });

  test('3. Azure via Terraform', async () => {
    const dir = makeProject({
      'main.tf': `
        provider "azurerm" {
          features {}
        }

        resource "azurerm_resource_group" "main" {
          name     = "my-resource-group"
          location = "East US"
        }

        resource "azurerm_storage_account" "storage" {
          name                     = "mystorageaccount"
          resource_group_name      = azurerm_resource_group.main.name
          location                 = azurerm_resource_group.main.location
          account_tier             = "Standard"
          account_replication_type = "LRS"
        }
      `
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('azure');
    expect(result.confidence).toBeCloseTo(WEIGHT.terraform / TOTAL_WEIGHT, 5);
    expect(result.results[0].signals.terraform).toBe(true);
  });

  test('4. AWS via NPM packages', async () => {
    const dir = makeProject({
      'package.json': JSON.stringify({
        name: 'aws-app',
        dependencies: {
          '@aws-sdk/client-s3': '^3.0.0',
          '@aws-sdk/client-dynamodb': '^3.0.0',
          'aws-cdk-lib': '^2.0.0'
        }
      }, null, 2)
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('aws');
    expect(result.confidence).toBeCloseTo(WEIGHT.npm / TOTAL_WEIGHT, 5);
    expect(result.results[0].signals.npm).toBe(true);
  });

  test('5. GCP via Python packages', async () => {
    const dir = makeProject({
      'requirements.txt': [
        'google-cloud-storage==2.10.0',
        'google-cloud-pubsub==2.18.0',
        'google-api-python-client==2.100.0'
      ].join('\n')
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('gcp');
    expect(result.confidence).toBeCloseTo(WEIGHT.python / TOTAL_WEIGHT, 5);
    expect(result.results[0].signals.python).toBe(true);
  });

  test('6. Azure via CLI scripts', async () => {
    const dir = makeProject({
      'deploy.sh': [
        '#!/bin/bash',
        'az login',
        'az vm create --resource-group myResourceGroup --name myVM --image UbuntuLTS',
        'az storage account create --name mystorageaccount --resource-group myResourceGroup'
      ].join('\n')
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('azure');
    expect(result.confidence).toBeCloseTo(WEIGHT.cli / TOTAL_WEIGHT, 5);
    expect(result.results[0].signals.cli).toBe(true);
  });

  test('7. AWS via Dockerfile', async () => {
    const dir = makeProject({
      Dockerfile: [
        'FROM public.ecr.aws/lambda/nodejs:18',
        'COPY package*.json ./',
        'RUN npm ci --production',
        'COPY . .',
        'CMD ["index.handler"]'
      ].join('\n')
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('aws');
    expect(result.confidence).toBeCloseTo(WEIGHT.docker / TOTAL_WEIGHT, 5);
    expect(result.results[0].signals.docker).toBe(true);
  });

  test('8. AWS multi-signal detection reaches the default threshold', async () => {
    const dir = makeProject({
      'main.tf': `
        provider "aws" {
          region = "us-east-1"
        }
        resource "aws_s3_bucket" "data" {
          bucket = "my-bucket"
        }
      `,
      'package.json': JSON.stringify({ dependencies: { '@aws-sdk/client-s3': '^3.0.0' } }),
      'deploy.sh': 'aws s3 sync ./dist s3://my-bucket',
      Dockerfile: 'FROM public.ecr.aws/lambda/nodejs:18'
    });

    const result = await detect('cloud', dir);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('aws');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    // (terraform + npm + cli + docker) / total + boost
    expect(result.confidence).toBeCloseTo((0.5 + 0.3 + 0.2 + 0.2) / TOTAL_WEIGHT + BOOST, 5);
    expect(result.results[0].signal_count).toBeGreaterThanOrEqual(3);
    expect(result.results[0].signal_count).toBe(4);
  });

  test('9. GCP via config files', async () => {
    const dir = makeProject({
      'cloudbuild.yaml': [
        'steps:',
        "  - name: 'gcr.io/cloud-builders/docker'",
        "    args: ['build', '-t', 'gcr.io/my-project/my-app', '.']"
      ].join('\n'),
      'service-account.json': JSON.stringify({ type: 'service_account', project_id: 'my-gcp-project' })
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('gcp');
    expect(result.confidence).toBeCloseTo(WEIGHT.config / TOTAL_WEIGHT, 5);
    expect(result.results[0].signals.config).toBe(true);
  });

  test('10. No cloud provider', async () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ dependencies: { express: '^4.18.0', react: '^18.2.0' } }),
      'index.js': 'console.log("Hello World");'
    });

    const result = await detect('cloud', dir);

    expect(result.detected).toBe(false);
    expect(result.primary).toBeNull();
    expect(result.confidence).toBeLessThan(0.7);
    expect(result.results).toEqual([]);
    expect(topCandidate(result).confidence).toBe(0);
  });

  test('11. Manual provider override', async () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ name: 'test' }) });

    const result = await detect('cloud', dir, { provider: 'aws' });

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('aws');
    expect(result.confidence).toBe(1.0);
    expect(result.manual_override).toBe(true);
  });

  test('12. Custom confidence threshold', async () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ dependencies: { '@aws-sdk/client-s3': '^3.0.0' } })
    });

    // A single npm signal scores 0.167: below 0.9, so not detected, but still ranked
    const strict = await detect('cloud', dir, { minimumConfidence: 0.9 });
    expect(strict.detected).toBe(false);
    expect(strict.threshold).toBe(0.9);
    expect(strict.all_results).toHaveLength(3);
    expect(topCandidate(strict).name).toBe('aws');
    expect(topCandidate(strict).confidence).toBeCloseTo(WEIGHT.npm / TOTAL_WEIGHT, 5);

    // The same project is detected once the threshold admits that score
    const lenient = await detect('cloud', dir, { minimumConfidence: 0.15 });
    expect(lenient.detected).toBe(true);
    expect(lenient.primary).toBe('aws');
  });

  test('13. Multi-cloud project (AWS + GCP)', async () => {
    const dir = makeProject({
      'main.tf': `
        provider "aws" {
          region = "us-east-1"
        }
        provider "google" {
          project = "my-project"
        }
        resource "aws_s3_bucket" "data" {
          bucket = "my-bucket"
        }
        resource "google_storage_bucket" "backup" {
          name = "my-backup"
        }
      `
    });

    const result = await detect('cloud', dir, { minimumConfidence: 0.2 });

    expect(result.detected).toBe(true);
    expect(result.all_results.length).toBeGreaterThan(1);

    // Both providers are scored, and both pass the threshold
    const aws = result.all_results.find(r => r.name === 'aws');
    const gcp = result.all_results.find(r => r.name === 'gcp');
    expect(aws.confidence).toBeGreaterThan(0);
    expect(gcp.confidence).toBeGreaterThan(0);
    expect(result.results.map(r => r.name).sort()).toEqual(['aws', 'gcp']);
  });

  test('14. AWS ECS/Fargate patterns', async () => {
    const dir = makeProject({
      'infrastructure.tf': `
        resource "aws_ecs_cluster" "main" {
          name = "my-cluster"
        }
        resource "aws_ecs_service" "app" {
          name = "my-app"
          cluster = aws_ecs_cluster.main.id
        }
      `
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('aws');
    expect(result.results[0].signals.terraform).toBe(true);
  });

  test('15. GCP Cloud Run patterns', async () => {
    const dir = makeProject({
      'main.tf': `
        resource "google_cloud_run_service" "app" {
          name     = "my-app"
          location = "us-central1"

          template {
            spec {
              containers {
                image = "gcr.io/my-project/my-app"
              }
            }
          }
        }
      `
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('gcp');
    expect(result.results[0].signals.terraform).toBe(true);
  });

  test('16. Azure AKS patterns', async () => {
    const dir = makeProject({
      'kubernetes.tf': `
        resource "azurerm_kubernetes_cluster" "main" {
          name                = "my-aks-cluster"
          location            = azurerm_resource_group.main.location
          resource_group_name = azurerm_resource_group.main.name
          dns_prefix          = "myaks"
        }
      `
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('azure');
    expect(result.results[0].signals.terraform).toBe(true);
  });

  test('17. AWS Lambda patterns (Terraform + Docker)', async () => {
    const dir = makeProject({
      'lambda.tf': `
        resource "aws_lambda_function" "handler" {
          filename      = "lambda_function.zip"
          function_name = "my_lambda"
          role          = aws_iam_role.lambda_role.arn
          handler       = "index.handler"
          runtime       = "nodejs18.x"
        }
      `,
      Dockerfile: 'FROM public.ecr.aws/lambda/nodejs:18'
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('aws');
    expect(result.results[0].signal_count).toBeGreaterThanOrEqual(2);
    expect(result.results[0].signals.terraform).toBe(true);
    expect(result.results[0].signals.docker).toBe(true);
  });

  test('18. Pattern case sensitivity', async () => {
    const dir = makeProject({
      'main.tf': `
        # Lowercase provider
        provider "aws" {
          region = "us-east-1"
        }

        # Uppercase in comments: AWS, GCP, AZURE should not affect detection
        resource "aws_s3_bucket" "data" {
          bucket = "my-bucket"
        }
      `
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('aws');
    expect(result.results.map(r => r.name)).toEqual(['aws']);
  });

  test('19. Nested directory structure', async () => {
    const dir = makeProject({
      'terraform/environments/prod/main.tf': `
        provider "aws" {
          region = "us-east-1"
        }
      `,
      'src/config/aws-config.js': "const AWS = require('@aws-sdk/client-s3');",
      'scripts/deploy/aws-deploy.sh': 'aws s3 sync ./dist s3://bucket'
    });

    const result = await detect('cloud', dir, SINGLE_SIGNAL);

    expect(result.detected).toBe(true);
    expect(result.primary).toBe('aws');
    // Terraform and the shell script are found in nested directories; the SDK
    // import in a source file is not a signal (only package.json is scanned).
    expect(result.results[0].signals.terraform).toBe(true);
    expect(result.results[0].signals.cli).toBe(true);
    expect(result.results[0].signals.npm).toBe(false);
    expect(result.results[0].signal_count).toBe(2);
  });

  test('20. Detection performance', async () => {
    const dir = makeProject({
      'main.tf': `
        provider "aws" { region = "us-east-1" }
        resource "aws_s3_bucket" "b1" { bucket = "b1" }
        resource "aws_s3_bucket" "b2" { bucket = "b2" }
        resource "aws_s3_bucket" "b3" { bucket = "b3" }
      `,
      'package.json': JSON.stringify({ dependencies: { '@aws-sdk/client-s3': '^3.0.0' } }),
      'requirements.txt': 'boto3==1.28.0',
      'deploy.sh': 'aws s3 sync . s3://bucket',
      Dockerfile: 'FROM public.ecr.aws/lambda/nodejs:18'
    });

    const start = Date.now();
    const result = await detect('cloud', dir);
    const duration = Date.now() - start;

    expect(result.detected).toBe(true);
    expect(result.confidence).toBe(1.0);
    // The original script allowed 100 ms. This suite runs in parallel jest
    // workers, so only guard against pathological scanning.
    expect(duration).toBeLessThan(2000);
  });
});

describe('cloud axis scoring (inherited from cloud-provider-detector 1.0.0)', () => {
  test('a single signal stays below the default 0.7 threshold', async () => {
    const dir = makeProject({ 'main.tf': 'provider "aws" {}\nresource "aws_vpc" "main" {}\n' });

    const result = await detect('cloud', dir);

    expect(result.detected).toBe(false);
    expect(result.threshold).toBe(0.7);
    expect(result.confidence).toBe(0);
    expect(topCandidate(result).name).toBe('aws');
    expect(topCandidate(result).confidence).toBeCloseTo(0.5 / 1.8, 5);
  });

  test('two signals stay below the default threshold (the boost needs 3)', async () => {
    const dir = makeProject({
      'main.tf': 'provider "aws" {}\n',
      Dockerfile: 'FROM public.ecr.aws/lambda/nodejs:18'
    });

    const result = await detect('cloud', dir);

    expect(result.detected).toBe(false);
    expect(topCandidate(result).signal_count).toBe(2);
    expect(topCandidate(result).confidence).toBeCloseTo((0.5 + 0.2) / 1.8, 5);
  });

  test('three signals add the per-provider 0.3 boost and pass the default threshold', async () => {
    const dir = makeProject({
      'main.tf': 'provider "aws" {}\n',
      'package.json': JSON.stringify({ dependencies: { 'aws-sdk': '^2' } }),
      'deploy.sh': 'aws ec2 describe-instances'
    });

    const result = await detect('cloud', dir);

    expect(result.detected).toBe(true);
    expect(result.results[0].signal_count).toBe(3);
    // detection_rules.multi_signal_boost (0.2) is not applied; confidence_boost (0.3) is
    expect(result.confidence).toBeCloseTo((0.5 + 0.3 + 0.2) / 1.8 + 0.3, 5);
  });

  test('confidence is capped at 1.0', async () => {
    const dir = makeProject({
      'main.tf': 'provider "gcp" {}\nprovider "google" {}\n',
      'package.json': JSON.stringify({ dependencies: { '@google-cloud/storage': '^6' } }),
      'requirements.txt': 'google-cloud-storage',
      'deploy.sh': 'gcloud compute instances list',
      Dockerfile: 'FROM gcr.io/google-appengine/nodejs',
      'cloudbuild.yaml': 'steps: []'
    });

    const result = await detect('cloud', dir);

    expect(result.primary).toBe('gcp');
    expect(result.confidence).toBe(1.0);
    expect(result.results[0].signal_count).toBe(6);
  });

  test('all_results lists every provider, best first, in the envelope shape', async () => {
    const dir = makeProject({ 'main.tf': 'provider "google" {}\n' });

    const result = await detect('cloud', dir);

    expect(result.axis).toBe('cloud');
    expect(result.all_results.map(r => r.name)).toEqual(['gcp', 'aws', 'azure']);
    for (const entry of result.all_results) {
      expect(Object.keys(entry.signals).sort()).toEqual(['cli', 'config', 'docker', 'npm', 'python', 'terraform']);
      expect(entry.signal_count).toBe(Object.values(entry.signals).filter(Boolean).length);
    }
  });

  test('an unknown provider override is rejected', async () => {
    const dir = makeProject({});

    await expect(detect('cloud', dir, { provider: 'gpc' })).rejects.toThrow("Unknown provider 'gpc'");
  });
});
