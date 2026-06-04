"""PDF テキスト抽出 Lambda: PyMuPDF + pymupdf4llm でデジタル PDF から高精度テキストを取得

ページごとに analyze_page() で OCR 要否を判定し、
find_tables() で表を Markdown 化する。

返り値の追加フィールド（後方互換: 未使用時は既存動作と等価）:
  pages[*].tables         : list[str] — 表の Markdown 文字列リスト
  pages[*].needsOcr       : bool      — OCR 推奨フラグ
  pages[*].ocrReason      : str|None  — 判定理由（analyze_page の reason）
  pages[*].charsBad       : int       — 0xFFFD 等の不正文字数
  pages[*].imgJoins       : float     — 画像がページを覆う割合
  pagesNeedOcr            : list[int] — OCR 推奨ページ番号リスト（Phase 2 分岐用）
"""

import boto3

s3 = boto3.client("s3")


def _analyze_page_fallback(page) -> dict:
    """analyze_page() が利用不可な場合の自前閾値判定。

    設計書 §5「判定基準」に準拠:
    - 不正文字率 > 10%  → chars_bad
    - 画像被覆率 > 80% → img_text
    """
    import pymupdf

    text = page.get_text()
    bad = text.count("�")
    total = max(len(text), 1)
    bad_ratio = bad / total

    page_area = page.rect.get_area()
    image_area = 0.0
    try:
        for b in page.get_text("dict")["blocks"]:
            if b["type"] == 1:
                image_area += pymupdf.Rect(b["bbox"]).get_area()
    except Exception:  # noqa: BLE001
        pass
    img_joins = image_area / max(page_area, 1.0)

    if bad_ratio > 0.1:
        needs_ocr, reason = True, "chars_bad"
    elif img_joins > 0.8:
        needs_ocr, reason = True, "img_text"
    else:
        needs_ocr, reason = False, None

    return {
        "needs_ocr": needs_ocr,
        "reason": reason,
        "chars_bad": bad,
        "chars_total": len(text),
        "img_joins": img_joins,
        "txt_joins": 0.0,
    }


def _analyze_page_safe(page) -> dict:
    """analyze_page() を一次判定として呼び出す。

    利用不可（ImportError / 実行時エラー）の場合は
    _analyze_page_fallback() に委譲する（設計書 §5）。
    """
    try:
        from pymupdf4llm.helpers.utils import analyze_page
        return analyze_page(page)
    except Exception:  # noqa: BLE001
        return _analyze_page_fallback(page)


def _should_use_ocr_for_tables(page) -> bool:
    """表処理を PyMuPDF で行うか OCR に回すか判定（設計書 §6 実装例に準拠）。

    Returns:
        True  → 表の大半が空セル → OCR 推奨
        False → PyMuPDF で処理可能
    """
    try:
        tables = page.find_tables()
        if not tables.tables:
            return False

        for table in tables.tables:
            cells = table.extract()
            total_cells = sum(len(row) for row in cells)
            empty_cells = sum(
                1 for row in cells for c in row if not c or not c.strip()
            )
            if total_cells > 0 and empty_cells / total_cells > 0.8:
                return True
    except Exception:  # noqa: BLE001
        pass
    return False


def handler(event, context):
    bucket = event["bucket"]
    key = event["key"]
    report_id = event["report_id"]

    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"].read()

    try:
        import pymupdf
    except ImportError:
        return {
            "bucket": bucket,
            "key": key,
            "report_id": report_id,
            "error": "pymupdf not available",
            "extractionType": "pdf-text",
        }

    doc = pymupdf.open(stream=body, filetype="pdf")
    pages = []
    full_text_parts = []
    pages_need_ocr = []

    for i, page in enumerate(doc):
        page_number = i + 1

        # テキスト抽出
        text = page.get_text()

        # ページ品質判定（analyze_page を一次判定として使用、設計書 §5）
        analysis = _analyze_page_safe(page)
        needs_ocr: bool = bool(analysis.get("needs_ocr", False))
        ocr_reason: str | None = analysis.get("reason")

        # 表抽出（設計書 §6: PyMuPDF で試して、ダメなら OCR へ）
        tables_md: list[str] = []
        try:
            if _should_use_ocr_for_tables(page):
                needs_ocr = True
                if not ocr_reason:
                    ocr_reason = "table_empty"
            else:
                for table in page.find_tables().tables:
                    md = table.to_markdown()
                    if md and md.strip():
                        tables_md.append(md)
        except Exception:  # noqa: BLE001
            pass  # 表抽出失敗は致命的ではない

        pages.append({
            "pageNumber": page_number,
            "text": text,
            "tables": tables_md,
            "needsOcr": needs_ocr,
            "ocrReason": ocr_reason,
            "charsBad": analysis.get("chars_bad", 0),
            "imgJoins": round(float(analysis.get("img_joins", 0.0)), 4),
        })
        full_text_parts.append(text)

        if needs_ocr:
            pages_need_ocr.append(page_number)

    doc.close()

    return {
        "bucket": bucket,
        "key": key,
        "report_id": report_id,
        "extractionType": "pdf-text",
        "pages": pages,
        "fullText": "\n".join(full_text_parts),
        "pageCount": len(pages),
        "pagesNeedOcr": pages_need_ocr,
        # Step Functions の Choice 条件で配列の空チェックを簡単にするための bool フラグ
        "hasPagesNeedOcr": len(pages_need_ocr) > 0,
    }
