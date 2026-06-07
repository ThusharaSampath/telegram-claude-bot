#!/usr/bin/env bash
# Register (or re-register) the Telegram webhook to point at the Cloud Run service.
# Usage: ./set-webhook.sh <CLOUD_RUN_URL>
#   e.g. ./set-webhook.sh https://telegram-expense-bot-xxxx.us-central1.run.app
set -euo pipefail

cd "$(dirname "$0")"
set -a; source .env; set +a

URL="${1:-}"
if [[ -z "${URL}" ]]; then echo "Usage: ./set-webhook.sh <CLOUD_RUN_URL>" >&2; exit 1; fi

WEBHOOK="${URL%/}/telegram"

echo "==> Setting webhook to ${WEBHOOK}"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"${WEBHOOK}\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\"]}"
echo ""
echo "==> Webhook info:"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
echo ""
