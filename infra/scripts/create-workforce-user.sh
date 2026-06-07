#!/usr/bin/env bash
# SageMaker A2I Private Workforce 用 Cognito ユーザーを作成し、レビュアーグループへ追加する。
#
# Web アプリ（AnalysisStack）の Cognito とは別プールです。
# 作成後はラベリングポータル URL からサインインし、Human Loop タスクを処理します。
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-quality-report}"
AWS_REGION="${AWS_DEFAULT_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
REVIEW_STACK="${REVIEW_STACK:-QualityReportReviewStack}"
WORKTEAM_NAME="${WORKTEAM_NAME:-${PROJECT_NAME}-quality-reviewers}"
REVIEWER_GROUP="${REVIEWER_GROUP:-quality-reviewers}"

usage() {
  cat <<'EOF'
Usage:
  EMAIL=reviewer@example.com [TEMP_PASSWORD='...'] ./create-workforce-user.sh

Environment:
  EMAIL              (required) レビュアーのメールアドレス（Cognito ユーザー名）
  TEMP_PASSWORD      (optional) 初期パスワード。未指定時は Cognito が一時パスワードをメール送信
  PROJECT_NAME       (optional) 既定: quality-report
  AWS_REGION         (optional) 既定: us-east-1
  REVIEW_STACK       (optional) CFN スタック名。既定: QualityReportReviewStack
  WORKTEAM_NAME      (optional) Workteam 名。CFN 出力が無い場合のフォールバック
  USER_POOL_ID       (optional) Workforce User Pool ID。未指定時はスタック出力から取得
  FORCE_CHANGE_PASSWORD  (optional) true なら初回ログイン時にパスワード変更を要求（既定: false）

Examples:
  EMAIL=reviewer@example.com TEMP_PASSWORD='TempPass1!' ./create-workforce-user.sh
  EMAIL=reviewer@example.com ./create-workforce-user.sh
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${EMAIL:-}" ]]; then
  echo "EMAIL を指定してください。" >&2
  usage >&2
  exit 1
fi

require_cmd aws

echo "region=${AWS_REGION}"
echo "review_stack=${REVIEW_STACK}"
echo "email=${EMAIL}"

if [[ -z "${USER_POOL_ID:-}" ]]; then
  USER_POOL_ID="$(aws cloudformation describe-stacks \
    --stack-name "${REVIEW_STACK}" \
    --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='WorkforceUserPoolIdOutput'].OutputValue" \
    --output text)"
  if [[ -z "${USER_POOL_ID}" || "${USER_POOL_ID}" == "None" ]]; then
    echo "Workforce User Pool ID を取得できません。USER_POOL_ID を直接指定するか、${REVIEW_STACK} をデプロイしてください。" >&2
    exit 1
  fi
fi

WORKTEAM_FROM_STACK="$(aws cloudformation describe-stacks \
  --stack-name "${REVIEW_STACK}" \
  --region "${AWS_REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='WorkteamNameOutput'].OutputValue" \
  --output text 2>/dev/null || true)"
if [[ -n "${WORKTEAM_FROM_STACK}" && "${WORKTEAM_FROM_STACK}" != "None" ]]; then
  WORKTEAM_NAME="${WORKTEAM_FROM_STACK}"
fi

echo "user_pool_id=${USER_POOL_ID}"
echo "workteam_name=${WORKTEAM_NAME}"

CREATE_ARGS=(
  --user-pool-id "${USER_POOL_ID}"
  --username "${EMAIL}"
  --user-attributes
  "Name=email,Value=${EMAIL}"
  "Name=email_verified,Value=true"
  --region "${AWS_REGION}"
)

if [[ -n "${TEMP_PASSWORD:-}" ]]; then
  CREATE_ARGS+=(--message-action SUPPRESS)
  echo "=== Creating user (password supplied, email suppressed) ==="
else
  echo "=== Creating user (Cognito will email a temporary password) ==="
fi

if aws cognito-idp admin-get-user \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${EMAIL}" \
  --region "${AWS_REGION}" >/dev/null 2>&1; then
  echo "User already exists: ${EMAIL}"
else
  aws cognito-idp admin-create-user "${CREATE_ARGS[@]}"
  echo "User created."
fi

if [[ -n "${TEMP_PASSWORD:-}" ]]; then
  PERMANENT_FLAG="--permanent"
  if [[ "${FORCE_CHANGE_PASSWORD:-false}" == "true" ]]; then
    PERMANENT_FLAG="--no-permanent"
  fi
  aws cognito-idp admin-set-user-password \
    --user-pool-id "${USER_POOL_ID}" \
    --username "${EMAIL}" \
    ${PERMANENT_FLAG} \
    --password "${TEMP_PASSWORD}" \
    --region "${AWS_REGION}"
  echo "Password set."
fi

echo "=== Adding user to group: ${REVIEWER_GROUP} ==="
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${EMAIL}" \
  --group-name "${REVIEWER_GROUP}" \
  --region "${AWS_REGION}" 2>/dev/null || echo "Already in group (or group add skipped)."

SUBDOMAIN="$(aws sagemaker describe-workteam \
  --workteam-name "${WORKTEAM_NAME}" \
  --region "${AWS_REGION}" \
  --query 'Workteam.SubDomain' \
  --output text)"

if [[ -n "${SUBDOMAIN}" && "${SUBDOMAIN}" != "None" ]]; then
  if [[ "${SUBDOMAIN}" == *".labeling."* ]]; then
    PORTAL_URL="https://${SUBDOMAIN}"
  else
    PORTAL_URL="https://${SUBDOMAIN}.labeling.${AWS_REGION}.sagemaker.aws"
  fi
else
  PORTAL_URL="(SubDomain を取得できませんでした)"
fi

cat <<EOF

=== Done ===
Reviewer:       ${EMAIL}
User pool:      ${USER_POOL_ID}
Group:          ${REVIEWER_GROUP}
Labeling portal: ${PORTAL_URL}

次の手順:
  1. 上記ラベリングポータルを開く
  2. Workforce 用 Cognito（プール名: ${PROJECT_NAME}-a2i-workforce）でサインイン
  3. レビュー管理画面の「レビュー待ち」に並んだタスクを処理する

Web アプリ（AnalysisStack の AppUrl）のログインとは別アカウントです。
EOF
