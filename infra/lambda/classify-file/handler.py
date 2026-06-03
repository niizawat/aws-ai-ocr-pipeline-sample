"""ファイル分類 Lambda: MIME 判定、Excel/PDF/スキャン振り分け"""

import json
import os
import re
import zipfile
import io
import hashlib
import urllib.parse
import boto3

s3 = boto3.client("s3")

def _derive_report_id(key: str) -> str:
    """SageMaker / Step Functions 向けに ASCII のみの report_id を生成する。"""
    stem = os.path.splitext(os.path.basename(key))[0]
    # presign: {YYYYMMDD}_{HHMMSS}_{8hex}_{元ファイル名}
    match = re.match(r"^(\d{8}_\d{6})_([0-9a-f]{8})(?:_|$)", stem, re.IGNORECASE)
    if match:
        return f"{match.group(1)}_{match.group(2)}"
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
    return f"report_{digest}"


def _normalize_event(event):
    """EventBridge Pipe (SQS) は単一メッセージでも配列で渡すため正規化する。"""
    if isinstance(event, list):
        if not event:
            raise ValueError("empty event list")
        event = event[0]
    return event


def handler(event, context):
    event = _normalize_event(event)
    bucket = event["bucket"]
    key = urllib.parse.unquote_plus(event["key"])
    report_id = _derive_report_id(key)

    result = {
        "bucket": bucket,
        "key": key,
        "report_id": report_id,
        "size": event.get("size"),
        "eventTime": event.get("eventTime"),
    }

    ext = os.path.splitext(key)[1].lower()

    if ext == ".pdf":
        obj = s3.get_object(Bucket=bucket, Key=key)
        body = obj["Body"].read()
        has_text = b"/Type /Page" in body and b"BT" in body and b"Tj" in body
        result["fileType"] = "digital-pdf" if has_text else "scan-pdf"

    elif ext == ".xlsx":
        obj = s3.get_object(Bucket=bucket, Key=key)
        body = obj["Body"].read()
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            has_shapes = any(
                name.startswith("xl/drawings/") for name in zf.namelist()
            )
        # すべての Excel は LibreOffice → PDF → OCR 経路で処理する
        result["fileType"] = "xlsx-with-shapes"
        result["hasDrawings"] = has_shapes

    else:
        result["fileType"] = "unknown"

    return result
