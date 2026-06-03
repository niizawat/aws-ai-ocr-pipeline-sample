"""OCR 非同期推論 結果チェック / パース Lambda

OCR は SageMaker 非同期推論エンドポイントとして実行される。Step Functions は
`invokeEndpointAsync` で投入後、Wait → 本 Lambda → Choice のループでポーリングする。

本 Lambda は非同期推論の OutputLocation / FailureLocation を S3 で確認し、
- 出力が存在: PaddleOCR-VL の Spotting 結果を後続契約（regions/confidence）へ整形し、
  `ocr-results/{report_id}.json` に保存して返す（ocrReady=true）。
- 失敗出力が存在: 低信頼度（confidence=0）として返し、レビュー送りにする（ocrReady=true）。
- いずれも未生成: ocrReady=false を返し、呼び出し側で再待機させる。

入力（Step Functions ステート入力）:
  bucket, key, report_id, ocrAsync:{OutputLocation, FailureLocation}

出力:
  {bucket, key, report_id, extractionType, ocrReady, ocrAsync,
   confidence?, ocrResults?}
"""

import json
import os
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError

s3 = boto3.client("s3")

REPORT_BUCKET = os.environ.get("REPORT_BUCKET", "")
OCR_RESULT_PREFIX = os.environ.get("OCR_RESULT_PREFIX", "ocr-results/")


def _parse_s3_uri(uri: str) -> tuple[str, str]:
    parsed = urlparse(uri)
    return parsed.netloc, parsed.path.lstrip("/")


def _object_exists(bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def _read_json(bucket: str, key: str) -> dict:
    obj = s3.get_object(Bucket=bucket, Key=key)
    return json.loads(obj["Body"].read().decode("utf-8"))


def handler(event, context):
    bucket = event.get("bucket", REPORT_BUCKET)
    key = event.get("key")
    report_id = event.get("report_id", "unknown")
    ocr_async = event.get("ocrAsync", {}) or {}
    output_location = ocr_async.get("OutputLocation")
    failure_location = ocr_async.get("FailureLocation")

    base = {
        "bucket": bucket,
        "key": key,
        "report_id": report_id,
        "extractionType": "ocr",
        "ocrAsync": ocr_async,
    }

    if not output_location:
        return {**base, "ocrReady": False}

    out_bucket, out_key = _parse_s3_uri(output_location)
    if _object_exists(out_bucket, out_key):
        prediction = _read_json(out_bucket, out_key)
        regions = prediction.get("regions", [])
        confidence = float(prediction.get("confidence", 0.0) or 0.0)
        ocr_results = {
            "regions": regions,
            "pages": prediction.get("pages"),
            "pageSizes": prediction.get("pageSizes", []),
            "markdown": prediction.get("markdown"),
        }
        _persist_result(bucket, report_id, confidence, ocr_results)
        return {
            **base,
            "ocrReady": True,
            "confidence": confidence,
            "ocrResults": ocr_results,
        }

    if failure_location:
        fail_bucket, fail_key = _parse_s3_uri(failure_location)
        if _object_exists(fail_bucket, fail_key):
            try:
                detail = (
                    s3.get_object(Bucket=fail_bucket, Key=fail_key)["Body"]
                    .read()
                    .decode("utf-8")
                )
            except Exception as exc:  # noqa: BLE001
                detail = f"failure output unreadable: {exc}"
            ocr_results = {"error": detail, "regions": []}
            _persist_result(bucket, report_id, 0.0, ocr_results)
            return {
                **base,
                "ocrReady": True,
                "confidence": 0.0,
                "ocrResults": ocr_results,
            }

    return {**base, "ocrReady": False}


def _persist_result(
    bucket: str, report_id: str, confidence: float, ocr_results: dict
) -> None:
    """トレーサビリティのため整形済み結果を ocr-results/ に保存する（失敗しても本処理は継続）。"""
    target_bucket = REPORT_BUCKET or bucket
    if not target_bucket:
        return
    payload = {
        "report_id": report_id,
        "extractionType": "ocr",
        "status": "succeeded" if confidence > 0 else "failed",
        "confidence": confidence,
        "ocrResults": ocr_results,
    }
    try:
        s3.put_object(
            Bucket=target_bucket,
            Key=f"{OCR_RESULT_PREFIX}{report_id}.json",
            Body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            ContentType="application/json",
        )
    except Exception:  # noqa: BLE001 - 保存失敗は致命的ではない
        pass
