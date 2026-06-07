#!/usr/bin/env bash
# Deploy the telegram-expense-bot to Cloud Run.
# Usage: ./deploy.sh
# Requires: gcloud authenticated, a .env file in this directory (see .env.example).
set -euo pipefail

cd "$(dirname "$0")"

PROJECT="${PROJECT:-serendib-custom}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-telegram-expense-bot}"
SA_NAME="${SA_NAME:-telegram-expense-bot}"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# Load .env into the current shell (export every assignment).
set -a; source .env; set +a

for v in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET CLAUDE_CODE_OAUTH_TOKEN SPREADSHEET_ID; do
  if [[ -z "${!v:-}" ]]; then echo "ERROR: $v is empty in .env" >&2; exit 1; fi
done

echo "==> Ensuring service account ${SA_EMAIL} exists"
if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --project "${PROJECT}" \
    --display-name "Telegram expense bot"
  echo "    Created. IMPORTANT: share your Google Sheet with ${SA_EMAIL} (Editor)."
else
  echo "    Exists. (Make sure the sheet is shared with ${SA_EMAIL} as Editor.)"
fi

echo "==> Deploying ${SERVICE} to Cloud Run (${REGION})"
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --source . \
  --service-account "${SA_EMAIL}" \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --timeout 300 \
  --max-instances 3 \
  --set-env-vars "MODEL=${MODEL:-sonnet},SHEET_NAME=${SHEET_NAME:-Transactions},SPREADSHEET_ID=${SPREADSHEET_ID},ALLOWED_CHAT_IDS=${ALLOWED_CHAT_IDS:-}" \
  --set-env-vars "^@@^TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}@@TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}@@CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}"

URL=$(gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --format='value(status.url)')
echo ""
echo "==> Deployed at: ${URL}"
echo "==> Now register the Telegram webhook:"
echo "    ./set-webhook.sh ${URL}"
