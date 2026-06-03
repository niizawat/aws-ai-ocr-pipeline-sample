"""統一スキーマ変換 Lambda: 各パスの抽出結果を統一 JSON スキーマに正規化"""

import json
import hashlib
from datetime import datetime, timezone


def handler(event, context):
    report_id = event.get("report_id", "unknown")
    extraction_type = event.get("extractionType", "unknown")
    bucket = event.get("bucket")
    key = event.get("key")

    sections = []

    if extraction_type == "excel":
        for sheet in event.get("sheets", []):
            section_id = hashlib.md5(
                f"{report_id}#{sheet['sheetName']}".encode()
            ).hexdigest()[:8]
            sections.append(
                {
                    "sectionId": section_id,
                    "sectionType": "spreadsheet",
                    "sheetName": sheet["sheetName"],
                    "content": sheet["rows"],
                }
            )
        for tb in event.get("textboxes", []):
            sections.append(
                {
                    "sectionId": hashlib.md5(tb["source"].encode()).hexdigest()[:8],
                    "sectionType": "textbox",
                    "content": tb["texts"],
                }
            )

    elif extraction_type == "pdf-text":
        for page in event.get("pages", []):
            page_number = page["pageNumber"]
            sections.append(
                {
                    "sectionId": f"page{page_number}",
                    "sectionType": "pdf-page",
                    "pageNumber": page_number,
                    "content": page["text"],
                    # OCR 品質情報（Phase 2 のフォールバック判定に利用）
                    "needsOcr": page.get("needsOcr", False),
                    "ocrReason": page.get("ocrReason"),
                }
            )
            # 表が抽出されていればセクションを追加（後方互換: tables キー無しは無視）
            for table_idx, table_md in enumerate(page.get("tables", [])):
                sections.append(
                    {
                        "sectionId": f"page{page_number}-table{table_idx + 1}",
                        "sectionType": "pdf-table",
                        "pageNumber": page_number,
                        "content": table_md,
                    }
                )

    elif extraction_type in ("excel-hybrid", "pdf-hybrid"):
        # PyMuPDF テキスト + 画像/グラフ OCR のハイブリッド抽出。
        # - PyMuPDF: 全ページのテキスト・表を pdf-page / pdf-table セクションへ
        # - OCR(PP-StructureV3): 視覚ブロック（figure/chart/image）のみ ocr-* セクションへ追加
        for page in event.get("pages", []):
            page_number = page["pageNumber"]
            if page.get("text", "").strip():
                sections.append(
                    {
                        "sectionId": f"page{page_number}",
                        "sectionType": "pdf-page",
                        "pageNumber": page_number,
                        "content": page["text"],
                    }
                )
            for table_idx, table_md in enumerate(page.get("tables", [])):
                sections.append(
                    {
                        "sectionId": f"page{page_number}-table{table_idx + 1}",
                        "sectionType": "pdf-table",
                        "pageNumber": page_number,
                        "content": table_md,
                    }
                )
        # OCR 視覚ブロック（テキスト以外の図・グラフ・画像）を追加
        _visual = {"figure", "chart", "image", "picture", "figure_title", "chart_title"}
        for region in event.get("ocrResults", {}).get("regions", []):
            label = region.get("blockLabel", "text")
            if label in _visual:
                sections.append(
                    {
                        "sectionId": region.get("regionId", "unknown"),
                        "sectionType": f"ocr-{label}",
                        "content": region.get("text", ""),
                        "confidence": region.get("confidence"),
                    }
                )
        # 写真の意味解釈（Bedrock Kimi K2.5）を photo-interpretation セクションへ
        for photo in event.get("photoInterpretations", []):
            page = photo.get("page", 0)
            sections.append(
                {
                    "sectionId": f"photo-page{page}",
                    "sectionType": "photo-interpretation",
                    "pageNumber": page,
                    "content": photo.get("interpretation", ""),
                }
            )

    elif extraction_type == "excel-pymupdf":
        # LibreOffice 変換後に PyMuPDF でテキスト抽出した経路（OCR スキップ）。
        # PDF ページテキストと表 Markdown を sections に格納する。
        for page in event.get("pages", []):
            page_number = page["pageNumber"]
            sections.append(
                {
                    "sectionId": f"page{page_number}",
                    "sectionType": "pdf-page",
                    "pageNumber": page_number,
                    "content": page["text"],
                }
            )
            for table_idx, table_md in enumerate(page.get("tables", [])):
                sections.append(
                    {
                        "sectionId": f"page{page_number}-table{table_idx + 1}",
                        "sectionType": "pdf-table",
                        "pageNumber": page_number,
                        "content": table_md,
                    }
                )

    elif extraction_type == "ocr":
        # PaddleOCR-VL のレイアウト種別（text/table/chart/formula/image 等）を
        # セクション種別へ反映する。表・グラフは構造化済みの内容が content に入る。
        for region in event.get("ocrResults", {}).get("regions", []):
            label = region.get("blockLabel", "text")
            sections.append(
                {
                    "sectionId": region.get("regionId", "unknown"),
                    "sectionType": f"ocr-{label}",
                    "content": region.get("text", ""),
                    "confidence": region.get("confidence", 0.0),
                }
            )

    # 写真の意味解釈（Bedrock Kimi K2.5）を文字/表/グラフのセクションへ統合する
    for photo in event.get("photoInterpretations", []):
        page = photo.get("page", 0)
        sections.append(
            {
                "sectionId": f"photo-page{page}",
                "sectionType": "photo-interpretation",
                "pageNumber": page,
                "content": photo.get("interpretation", ""),
            }
        )

    result = {
        "report_id": report_id,
        "bucket": bucket,
        "key": key,
        "normalizedData": {
            "reportId": report_id,
            "sourceFile": key,
            "extractionType": extraction_type,
            "extractedAt": datetime.now(timezone.utc).isoformat(),
            "sections": sections,
        },
    }
    # A2I 完了後の store-results が人間レビュー済みと判定できるよう引き継ぐ
    for field in ("reviewStatus", "humanLoopName", "reviewedData"):
        if field in event:
            result[field] = event[field]
    return result
