#!/usr/bin/env bash
# Deploy the calorie bot to Cloud Run.
# Usage: ./deploy.sh
# Requires: gcloud authenticated, a .env file in this directory (see .env.example).
set -euo pipefail

cd "$(dirname "$0")"

PROJECT="${PROJECT:-serendib-custom}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-telegram-calorie-bot}"
# Needs roles/datastore.user, plus Editor on the sheet.
SA_EMAIL="${SA_EMAIL:-healthy-bot@${PROJECT}.iam.gserviceaccount.com}"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi
set -a; source .env; set +a

for v in TELEGRAM_WEBHOOK_SECRET CLAUDE_CODE_OAUTH_TOKEN; do
  if [[ -z "${!v:-}" ]]; then echo "ERROR: $v is empty in .env" >&2; exit 1; fi
done

echo "==> Deploying ${SERVICE} to Cloud Run (${REGION})"
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --source . \
  --service-account "${SA_EMAIL}" \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --timeout 120 \
  --max-instances 2 \
  --set-env-vars "MODEL=${MODEL:-sonnet},TZ_NAME=${TZ_NAME:-Asia/Colombo},ALLOWED_CHAT_IDS=${ALLOWED_CHAT_IDS:-},SPREADSHEET_ID=${SPREADSHEET_ID:-},SHEET_NAME=${SHEET_NAME:-daily-calories-protein-data}" \
  --set-env-vars "^@@^TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}@@CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}@@SYNC_SECRET=${SYNC_SECRET:-}"

URL=$(gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --format='value(status.url)')
echo ""
echo "==> Deployed at: ${URL}"
if [[ -n "${SYNC_SECRET:-}" ]]; then
  echo "==> Scheduling nightly sheet sync (23:59 ${TZ_NAME:-Asia/Colombo})"
  JOB_ARGS=(--project "${PROJECT}" --location "${REGION}"
    --schedule "59 23 * * *" --time-zone "${TZ_NAME:-Asia/Colombo}"
    --uri "${URL}/sync" --http-method POST --attempt-deadline 60s)
  if gcloud scheduler jobs describe "${SERVICE}-sync" --project "${PROJECT}" --location "${REGION}" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "${SERVICE}-sync" "${JOB_ARGS[@]}" --update-headers "X-Sync-Secret=${SYNC_SECRET}"
  else
    gcloud scheduler jobs create http "${SERVICE}-sync" "${JOB_ARGS[@]}" --headers "X-Sync-Secret=${SYNC_SECRET}"
  fi
fi
echo "==> Now register the Telegram webhook:"
echo "    ./set-webhook.sh ${URL}"
