"""A2I 完了イベント処理 Lambda: レビュー結果を受け取り Step Functions を再開"""

import json
import os

import boto3

sfn_client = boto3.client("stepfunctions")
a2i = boto3.client("sagemaker-a2i-runtime")
s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

REPORT_BUCKET = os.environ.get("REPORT_BUCKET", "")
TABLE_NAME = os.environ.get("TABLE_NAME", "")
PENDING_PAGE_SECTION = "_a2i_pending"


def _load_review_backup(human_loop_name: str) -> dict:
    if not (REPORT_BUCKET and human_loop_name):
        return {}
    try:
        obj = s3.get_object(
            Bucket=REPORT_BUCKET, Key=f"review-tokens/{human_loop_name}.json"
        )
        return json.loads(obj["Body"].read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _clear_pending_row(report_id: str) -> None:
    """A2I 完了後にレビュー待ちプレースホルダーを除去（パイプライン失敗時の残留防止）。"""
    if not (TABLE_NAME and report_id):
        return
    try:
        dynamodb.Table(TABLE_NAME).delete_item(
            Key={"report_id": report_id, "page_section": PENDING_PAGE_SECTION}
        )
    except Exception:  # noqa: BLE001
        pass


def handler(event, context):
    detail = event.get("detail", {})
    human_loop_name = detail.get("humanLoopName") or detail.get("HumanLoopName", "")

    backup = _load_review_backup(human_loop_name)

    loop_info = a2i.describe_human_loop(HumanLoopName=human_loop_name)
    human_loop_input = loop_info.get("HumanLoopInput") or {}
    input_content = json.loads(human_loop_input.get("InputContent", "{}"))

    task_token = input_content.get("taskToken") or backup.get("taskToken")
    original_input = input_content.get("input") or backup.get("input") or {}
    report_id = original_input.get("report_id") or backup.get("reportId")

    output_s3_uri = (
        detail.get("humanLoopOutput", {}).get("outputS3Uri")
        or loop_info.get("HumanLoopOutput", {}).get("OutputS3Uri", "")
    )
    reviewed_data = {}
    if output_s3_uri.startswith("s3://"):
        parts = output_s3_uri.replace("s3://", "").split("/", 1)
        if len(parts) == 2:
            review_obj = s3.get_object(Bucket=parts[0], Key=parts[1])
            reviewed_data = json.loads(review_obj["Body"].read().decode("utf-8"))

    result = {
        **original_input,
        "reviewedData": reviewed_data,
        "reviewStatus": "approved",
        "humanLoopName": human_loop_name,
    }

    if task_token:
        sfn_client.send_task_success(
            taskToken=task_token,
            output=json.dumps(result, ensure_ascii=False, default=str),
        )
        _clear_pending_row(report_id)
    elif report_id:
        # Step Functions 再開不可でもレビュー待ち一覧からは外す
        _clear_pending_row(report_id)

    return {
        "status": "success",
        "humanLoopName": human_loop_name,
        "reportId": report_id,
        "resumed": bool(task_token),
    }
