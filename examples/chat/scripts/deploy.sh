#!/usr/bin/env bash
# Builds and deploys the example chat: backend bundles -> CloudFormation stack -> frontend -> S3 + CloudFront.
# Uses the AWS CLI only: CloudFormation runs the SAM transform, so the SAM CLI is not needed.
# Env: WORKER_ENGINE (strands | minamo; default strands) - the agent layer of the worker.
#      STACK_NAME (default strands-durable-chat, or minamo-durable-chat for minamo), AWS_REGION (default us-east-1),
#      AWS_PROFILE (optional), ARTIFACT_BUCKET (default: durable-chat-artifacts-<account>-<region>, created if missing),
#      COGNITO_DOMAIN_PREFIX and BEDROCK_MODEL_ID (optional stack parameter overrides).
set -euo pipefail

WORKER_ENGINE="${WORKER_ENGINE:-strands}"
export WORKER_ENGINE
case "${WORKER_ENGINE}" in
  strands) STACK_NAME="${STACK_NAME:-strands-durable-chat}" ;;
  minamo) STACK_NAME="${STACK_NAME:-minamo-durable-chat}" ;;
  *) echo "Unknown WORKER_ENGINE: ${WORKER_ENGINE} (strands | minamo)" >&2; exit 1 ;;
esac
AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

echo "==> Building backend (${WORKER_ENGINE} worker)"
npm run build -w @strands-lambda-durable/example-chat-backend

account="$(aws sts get-caller-identity --query Account --output text)"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-durable-chat-artifacts-${account}-${AWS_REGION}}"
if ! aws s3api head-bucket --bucket "${ARTIFACT_BUCKET}" 2>/dev/null; then
  echo "==> Creating artifact bucket ${ARTIFACT_BUCKET}"
  if [[ "${AWS_REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${ARTIFACT_BUCKET}" >/dev/null
  else
    aws s3api create-bucket --bucket "${ARTIFACT_BUCKET}" --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "${ARTIFACT_BUCKET}" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# Cognito domain prefixes are global; the template's default is taken by the strands stack of the same account.
if [[ "${WORKER_ENGINE}" == "minamo" && -z "${COGNITO_DOMAIN_PREFIX:-}" ]]; then COGNITO_DOMAIN_PREFIX="minamo-durable-${account}"; fi
overrides=()
if [[ -n "${COGNITO_DOMAIN_PREFIX:-}" ]]; then overrides+=("CognitoDomainPrefix=${COGNITO_DOMAIN_PREFIX}"); fi
if [[ -n "${BEDROCK_MODEL_ID:-}" ]]; then overrides+=("BedrockModelId=${BEDROCK_MODEL_ID}"); fi

BACKEND=examples/chat/backend
echo "==> Packaging to s3://${ARTIFACT_BUCKET}/${STACK_NAME}"
aws cloudformation package --template-file "${BACKEND}/template.yaml" --s3-bucket "${ARTIFACT_BUCKET}" \
  --s3-prefix "${STACK_NAME}" --output-template-file "${BACKEND}/dist/packaged.yaml" >/dev/null

echo "==> Deploying stack ${STACK_NAME} (${AWS_REGION})"
aws cloudformation deploy \
  --template-file "${BACKEND}/dist/packaged.yaml" \
  --stack-name "${STACK_NAME}" \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --no-fail-on-empty-changeset \
  ${overrides[@]+--parameter-overrides "${overrides[@]}"}

output() {
  aws cloudformation describe-stacks --region "${AWS_REGION}" --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
SITE_BUCKET="$(output SiteBucketName)"
DISTRIBUTION_ID="$(output DistributionId)"
SITE_URL="$(output SiteUrl)"
USER_POOL_ID="$(output UserPoolId)"
USER_POOL_CLIENT_ID="$(output UserPoolClientId)"
COGNITO_DOMAIN="$(output CognitoDomain)"
EVENTS_HTTP_DOMAIN="$(output EventsHttpDomain)"
EVENTS_REALTIME_DOMAIN="$(output EventsRealtimeDomain)"

echo "==> Building frontend"
npm run build -w @strands-lambda-durable/example-chat-frontend
DIST=examples/chat/frontend/dist
cat > "${DIST}/config.json" <<EOF
{
  "region": "${AWS_REGION}",
  "userPoolId": "${USER_POOL_ID}",
  "userPoolClientId": "${USER_POOL_CLIENT_ID}",
  "cognitoDomain": "${COGNITO_DOMAIN}",
  "apiBaseUrl": "/api",
  "eventsHttpDomain": "${EVENTS_HTTP_DOMAIN}",
  "eventsRealtimeDomain": "${EVENTS_REALTIME_DOMAIN}",
  "engine": "${WORKER_ENGINE}"
}
EOF

echo "==> Uploading site to s3://${SITE_BUCKET}"
# Hashed assets first, so a new index.html never references missing files. Old assets are kept for clients
# that still run the previous index.html.
if [[ -d "${DIST}/assets" ]]; then
  aws s3 sync "${DIST}/assets" "s3://${SITE_BUCKET}/assets" --region "${AWS_REGION}" \
    --cache-control "public,max-age=31536000,immutable"
fi
aws s3 sync "${DIST}" "s3://${SITE_BUCKET}" --region "${AWS_REGION}" --delete \
  --exclude "assets/*" --cache-control "no-cache"

echo "==> Invalidating CloudFront ${DISTRIBUTION_ID}"
aws cloudfront create-invalidation --distribution-id "${DISTRIBUTION_ID}" --paths "/*" \
  --query "Invalidation.Id" --output text

echo "==> Done: ${SITE_URL}"
