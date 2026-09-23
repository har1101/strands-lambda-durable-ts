#!/usr/bin/env bash
# Builds and deploys the example chat: library -> backend bundles -> SAM stack -> frontend -> S3 + CloudFront.
# Env: STACK_NAME (default strands-durable-chat), AWS_REGION (default us-east-1), AWS_PROFILE (optional),
#      COGNITO_DOMAIN_PREFIX and BEDROCK_MODEL_ID (optional stack parameter overrides).
set -euo pipefail

STACK_NAME="${STACK_NAME:-strands-durable-chat}"
AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

echo "==> Building library and backend"
npm run build -w strands-lambda-durable
npm run build -w @strands-lambda-durable/example-chat-backend

overrides=()
if [[ -n "${COGNITO_DOMAIN_PREFIX:-}" ]]; then overrides+=("CognitoDomainPrefix=${COGNITO_DOMAIN_PREFIX}"); fi
if [[ -n "${BEDROCK_MODEL_ID:-}" ]]; then overrides+=("BedrockModelId=${BEDROCK_MODEL_ID}"); fi

echo "==> Deploying stack ${STACK_NAME} (${AWS_REGION})"
sam deploy \
  --template-file examples/chat/backend/template.yaml \
  --stack-name "${STACK_NAME}" \
  --region "${AWS_REGION}" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
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
  "eventsRealtimeDomain": "${EVENTS_REALTIME_DOMAIN}"
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
