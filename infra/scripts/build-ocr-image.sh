#!/usr/bin/env bash
# OCR イメージを CodeBuild でビルドし ECR へ push する（手動再実行用）。
#
# 前提: QualityReportEcrStack / QualityReportCodeBuildStack をデプロイ済みであること。
# 通常は CodeBuildStack の CustomResource が自動で実行するため、このスクリプトは
# 失敗時の手動リトライ用途。
#
# 使い方:
#   AWS 認証を通したシェルで:
#     AWS_DEFAULT_REGION=us-east-1 ./scripts/build-ocr-image.sh
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
PROJECT="${PROJECT_NAME:-quality-report}"
IMAGE_TAG="${OCR_IMAGE_TAG:-latest}"
BUILD_PROJECT="${PROJECT}-ocr-build"

start_and_wait() {
  local proj="$1"
  echo "==> Starting CodeBuild project: ${proj}"
  local build_id
  build_id="$(aws codebuild start-build \
    --project-name "${proj}" \
    --region "${REGION}" \
    --query 'build.id' --output text)"
  echo "    build id: ${build_id}"
  while true; do
    local status
    status="$(aws codebuild batch-get-builds \
      --ids "${build_id}" --region "${REGION}" \
      --query 'builds[0].buildStatus' --output text)"
    case "${status}" in
      SUCCEEDED)
        echo "    ${proj}: SUCCEEDED"
        break
        ;;
      IN_PROGRESS)
        sleep 20
        ;;
      *)
        echo "    ${proj}: ${status}（CodeBuild コンソールでログを確認してください）"
        exit 1
        ;;
    esac
  done
}

start_and_wait "${BUILD_PROJECT}"

echo "完了: ${PROJECT}/paddleocr-vl:${IMAGE_TAG} を ECR へ push しました。"
echo "次に OcrStack をデプロイしてください（必要なら -c ocrImageTag=${IMAGE_TAG}）。"
