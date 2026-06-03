"""結果格納 Lambda: DynamoDB メタデータ + S3 構造化結果 JSON を保存"""

import json
import os
from datetime import datetime, timezone
import boto3

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

REPORT_BUCKET = os.environ.get("REPORT_BUCKET", "")
TABLE_NAME = os.environ.get("TABLE_NAME", "")
PENDING_PAGE_SECTION = "_a2i_pending"


def handler(event, context):
    report_id = event.get("report_id", "unknown")
    normalized = event.get("normalizedData", {})
    bucket = event.get("bucket") or REPORT_BUCKET
    if not bucket:
        raise ValueError("REPORT_BUCKET / event.bucket が未設定です")

    result_key = f"results/{report_id}/result.json"
    s3.put_object(
        Bucket=bucket,
        Key=result_key,
        Body=json.dumps(normalized, ensure_ascii=False, default=str),
        ContentType="application/json",
    )

    table = dynamodb.Table(TABLE_NAME)
    now = datetime.now(timezone.utc).isoformat()

    # A2I 待ちプレースホルダー行を削除（レビュー完了または高信頼度直行時）
    try:
        table.delete_item(
            Key={
                "report_id": report_id,
                "page_section": PENDING_PAGE_SECTION,
            }
        )
    except Exception:
        pass

    # A2I 経由の人間レビュー完了と、高信頼度の自動完了を区別する
    human_reviewed = bool(
        event.get("humanLoopName")
        or event.get("reviewStatus") in ("approved", "edit_approve")
    )
    review_status = "human_reviewed" if human_reviewed else "completed"

    for section in normalized.get("sections", []):
        item = {
            "report_id": report_id,
            "page_section": section.get("sectionId", "unknown"),
            "source_file": normalized.get("sourceFile", ""),
            "source_type": normalized.get("extractionType", ""),
            "extracted_at": now,
            "confidence_score": str(section.get("confidence", 1.0)),
            "review_status": review_status,
            "report_date": now[:10],
            "content_text": (
                json.dumps(section.get("content", ""), ensure_ascii=False)
                if not isinstance(section.get("content"), str)
                else section.get("content", "")
            ),
        }
        if event.get("humanLoopName"):
            item["human_loop_name"] = event["humanLoopName"]
        table.put_item(Item=item)

    return {
        "report_id": report_id,
        "resultKey": result_key,
        "sectionsStored": len(normalized.get("sections", [])),
        "status": "stored",
    }
