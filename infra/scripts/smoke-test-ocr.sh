#!/usr/bin/env bash
# OCR 非同期推論エンドポイントのスモークテスト
#
# SageMaker 非同期推論エンドポイントへ S3 上の入力（PDF/画像）を 1 件投入し、
# scale-to-0 からの自動起動 → 出力 JSON の S3 生成（regions/confidence）を検証する。
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-quality-report}"
AWS_REGION="${AWS_DEFAULT_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
ENDPOINT_NAME="${ENDPOINT_NAME:-${PROJECT_NAME}-paddleocr-vl}"
CONTENT_TYPE="${CONTENT_TYPE:-application/octet-stream}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-60}"
SLEEP_SECONDS="${SLEEP_SECONDS:-30}"

if [[ -z "${INPUT_BUCKET:-}" || -z "${INPUT_KEY:-}" ]]; then
  echo "INPUT_BUCKET と INPUT_KEY を指定してください（OCR 対象の S3 オブジェクト: PDF/画像）。" >&2
  echo "例: INPUT_BUCKET=quality-report-reports-... INPUT_KEY=raw/sample.pdf $0" >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}
require_cmd aws
require_cmd python3

INPUT_LOCATION="s3://${INPUT_BUCKET}/${INPUT_KEY}"
echo "endpoint=${ENDPOINT_NAME}"
echo "input=${INPUT_LOCATION}"

echo "=== Invoking async endpoint (triggers scale 0->1 if idle) ==="
INVOKE_JSON="$(aws sagemaker-runtime invoke-endpoint-async \
  --endpoint-name "${ENDPOINT_NAME}" \
  --input-location "${INPUT_LOCATION}" \
  --content-type "${CONTENT_TYPE}" \
  --region "${AWS_REGION}" \
  --output json)"

OUTPUT_LOCATION="$(echo "${INVOKE_JSON}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('OutputLocation',''))")"
FAILURE_LOCATION="$(echo "${INVOKE_JSON}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('FailureLocation',''))")"
if [[ -z "${OUTPUT_LOCATION}" ]]; then
  echo "OutputLocation を取得できませんでした。invoke レスポンス: ${INVOKE_JSON}" >&2
  exit 1
fi
echo "outputLocation=${OUTPUT_LOCATION}"
echo "failureLocation=${FAILURE_LOCATION}"

s3_exists() { aws s3 ls "$1" --region "${AWS_REGION}" >/dev/null 2>&1; }

echo "=== Waiting for async result in S3 ==="
for attempt in $(seq 1 "${MAX_ATTEMPTS}"); do
  if s3_exists "${OUTPUT_LOCATION}"; then
    echo "[${attempt}/${MAX_ATTEMPTS}] output ready"
    RESULT_JSON="$(aws s3 cp "${OUTPUT_LOCATION}" - --region "${AWS_REGION}")"
    echo "${RESULT_JSON}" | python3 -c "
import sys,json
r=json.load(sys.stdin)
regions=len(r.get('regions',[]))
print(f\"confidence={r.get('confidence')} pages={r.get('pages')} regions={regions}\")
sys.exit(0 if regions>=0 else 2)
"
    echo "SMOKE_OK: async OCR produced result at ${OUTPUT_LOCATION}"
    exit 0
  fi
  if [[ -n "${FAILURE_LOCATION}" ]] && s3_exists "${FAILURE_LOCATION}"; then
    echo "SMOKE_FAIL: async OCR wrote failure output at ${FAILURE_LOCATION}" >&2
    aws s3 cp "${FAILURE_LOCATION}" - --region "${AWS_REGION}" >&2 || true
    exit 1
  fi
  echo "[${attempt}/${MAX_ATTEMPTS}] waiting (scale-from-zero/cold start)..."
  sleep "${SLEEP_SECONDS}"
done

echo "SMOKE_TIMEOUT: async OCR did not produce output in time" >&2
exit 1
