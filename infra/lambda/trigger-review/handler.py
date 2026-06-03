"""A2I レビュー開始 Lambda: 低信頼度結果に対して Human Loop を起動"""

import json
import os
import re
import time
from html import unescape
from html.parser import HTMLParser

import boto3
from datetime import datetime, timezone

a2i = boto3.client("sagemaker-a2i-runtime")
s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

FLOW_DEFINITION_ARN = os.environ.get("FLOW_DEFINITION_ARN", "")
REPORT_BUCKET = os.environ.get("REPORT_BUCKET", "")
TABLE_NAME = os.environ.get("TABLE_NAME", "")
# store-results と共有するプレースホルダー行（レビュー待ち一覧用）
PENDING_PAGE_SECTION = "_a2i_pending"


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self.parts.append(text)


def _strip_html(value: str) -> str:
    parser = _HTMLTextExtractor()
    parser.feed(unescape(value))
    return " ".join(parser.parts)


def _resolve_preview_image_key(bucket: str, report_id: str) -> str:
    """レビュー UI 用のページ画像キー（LibreOffice 変換の PNG）。"""
    prefix = f"images/{report_id}/"
    paginator = s3.get_paginator("list_objects_v2")
    keys: list[str] = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj.get("Key", "")
            if key.lower().endswith(".png"):
                keys.append(key)
    if not keys:
        return ""
    keys.sort()
    return keys[0]


def _resolve_preview_image_url(bucket: str, report_id: str) -> str:
    """A2I ワーカー UI の img 用 HTTPS URL（既存テンプレートでも表示可能）。"""
    key = _resolve_preview_image_key(bucket, report_id)
    if key:
        # タスク制限 1 時間 + バッファ
        return s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=7200,
        )
    return ""


def _build_page_section(ocr_results: dict) -> str:
    regions = ocr_results.get("regions") or []
    pages = sorted({r.get("page") for r in regions if r.get("page") is not None})
    if not pages:
        pages_count = ocr_results.get("pages")
        if isinstance(pages_count, int) and pages_count > 0:
            pages = list(range(1, pages_count + 1))
    if not pages:
        return "ページ 1"
    if len(pages) == 1:
        return f"ページ {pages[0]}"
    return f"ページ {pages[0]}–{pages[-1]}（全 {len(pages)} ページ）"


def _build_extracted_text(ocr_results: dict) -> str:
    """レビュー画面向けプレーンテキスト（OCR の HTML 表はタグ除去）。"""
    markdown = (ocr_results.get("markdown") or "").strip()
    if markdown:
        if "<" in markdown:
            markdown = _strip_html(markdown)
        return markdown[:12000]

    regions = ocr_results.get("regions") or []
    chunks: list[str] = []
    for region in regions:
        text = (region.get("text") or "").strip()
        if not text:
            continue
        if "<" in text:
            text = _strip_html(text)
        if not text:
            continue
        label = region.get("blockLabel") or region.get("type") or "block"
        chunks.append(f"[{label}] {text}")
    return "\n\n".join(chunks)[:12000]


def _build_defect_hint(input_data: dict, ocr_results: dict) -> str:
    excel = input_data.get("excelData") or {}
    if isinstance(excel, dict):
        shapes = excel.get("shapes") or excel.get("drawings") or []
        if shapes:
            return f"Excel 図形オブジェクト {len(shapes)} 件（要確認）"
    regions = ocr_results.get("regions") or []
    titles = [
        (r.get("text") or "").strip()
        for r in regions
        if (r.get("blockLabel") or "") in ("title", "figure_title", "paragraph_title")
    ]
    if titles:
        return titles[0][:500]
    return ""


def _build_task_input(
    *,
    task_token: str | None,
    input_data: dict,
    report_id: str,
    bucket: str,
    confidence: float,
    ocr_results: dict,
) -> dict:
    """HumanTaskUi テンプレート（task.input.*）と review-complete 用の構造を組み立てる。"""
    preview_url = _resolve_preview_image_url(bucket, report_id)

    return {
        "taskToken": task_token,
        "input": input_data,
        "originalImageUrl": preview_url,
        "confidenceScore": f"{confidence:.4f}",
        "reportId": report_id,
        "pageSection": _build_page_section(ocr_results),
        "extractedText": _build_extracted_text(ocr_results),
        "defectType": _build_defect_hint(input_data, ocr_results),
    }


def handler(event, context):
    task_token = event.get("taskToken")
    input_data = event.get("input", event)

    report_id = input_data.get("report_id", "unknown")
    bucket = input_data.get("bucket", REPORT_BUCKET)
    confidence = float(input_data.get("confidence", 0.0) or 0.0)
    ocr_results = input_data.get("ocrResults", {}) or {}

    # A2I HumanLoopName: 英数字とハイフンのみ（アンダースコア不可）
    safe_id = re.sub(r"[^a-zA-Z0-9]+", "-", report_id).strip("-") or "unknown"
    human_loop_name = f"review-{safe_id}-{int(time.time())}"[:63]

    human_loop_input = _build_task_input(
        task_token=task_token,
        input_data=input_data,
        report_id=report_id,
        bucket=bucket,
        confidence=confidence,
        ocr_results=ocr_results,
    )

    response = a2i.start_human_loop(
        HumanLoopName=human_loop_name,
        FlowDefinitionArn=FLOW_DEFINITION_ARN,
        HumanLoopInput={
            "InputContent": json.dumps(human_loop_input, ensure_ascii=False)
        },
    )

    if task_token and bucket:
        s3.put_object(
            Bucket=bucket,
            Key=f"review-tokens/{human_loop_name}.json",
            Body=json.dumps(
                {
                    "taskToken": task_token,
                    "reportId": report_id,
                    "input": input_data,
                },
                ensure_ascii=False,
                default=str,
            ).encode("utf-8"),
            ContentType="application/json",
        )

    if TABLE_NAME:
        table = dynamodb.Table(TABLE_NAME)
        now = datetime.now(timezone.utc).isoformat()
        source_key = input_data.get("key", "")
        table.put_item(
            Item={
                "report_id": report_id,
                "page_section": PENDING_PAGE_SECTION,
                "source_file": os.path.basename(source_key) if source_key else "",
                "source_type": input_data.get("extractionType", "ocr"),
                "extracted_at": now,
                "report_date": now[:10],
                "confidence_score": f"{confidence:.4f}",
                "review_status": "pending_review",
                "human_loop_name": human_loop_name,
                "content_text": human_loop_input.get("pageSection", ""),
            }
        )

    return {
        "humanLoopName": human_loop_name,
        "humanLoopArn": response.get("HumanLoopArn"),
        "status": "review-started",
    }
