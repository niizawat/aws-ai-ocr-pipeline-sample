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


def _classify_pdf(body: bytes) -> str:
    """PyMuPDF でページテキスト品質を判定し digital-pdf / scan-pdf を返す。

    判定基準（設計書 §5 に準拠）:
    - 全ページのうち 50% 以上が「十分なテキストあり + 不正文字率 < 5%」
      → digital-pdf（PyMuPDF テキスト抽出が有効）
    - それ以外 → scan-pdf（PaddleOCR フォールバック）

    旧実装はバイト列に `/Type /Page`・`BT`・`Tj` があるかのみを確認していたため、
    CID フォント等で文字化けするデジタル PDF を誤って digital-pdf に分類していた。
    PyMuPDF では実際のテキスト品質を確認するため、誤分類を大幅に削減できる。
    """
    try:
        import fitz
    except ImportError:
        # フォールバック: 旧バイト列検査
        has_text = b"/Type /Page" in body and b"BT" in body and b"Tj" in body
        return "digital-pdf" if has_text else "scan-pdf"

    try:
        doc = fitz.open(stream=body, filetype="pdf")
    except Exception:  # noqa: BLE001
        return "scan-pdf"

    total_pages = len(doc)
    if total_pages == 0:
        doc.close()
        return "scan-pdf"

    digital_pages = 0
    for page in doc:
        text = page.get_text()
        total_chars = len(text)
        if total_chars < 20:
            # テキストが極端に少ない → スキャンページ候補
            continue
        bad_chars = text.count("�")
        bad_ratio = bad_chars / total_chars
        if bad_ratio < 0.05:
            # 十分なテキストかつ不正文字率が低い → デジタルページと判定
            digital_pages += 1

    doc.close()

    # 過半数のページがデジタルページなら digital-pdf
    return "digital-pdf" if digital_pages / total_pages >= 0.5 else "scan-pdf"


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
        result["fileType"] = _classify_pdf(body)

    elif ext == ".xlsx":
        obj = s3.get_object(Bucket=bucket, Key=key)
        body = obj["Body"].read()
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            has_shapes = any(
                name.startswith("xl/drawings/") for name in zf.namelist()
            )
        # すべての Excel は LibreOffice → PyMuPDF 経路で処理する
        result["fileType"] = "xlsx-with-shapes"
        result["hasDrawings"] = has_shapes

    elif ext in (".docx", ".doc"):
        # Word ファイル: LibreOffice → PyMuPDF テキスト抽出
        result["fileType"] = "docx"

    else:
        result["fileType"] = "unknown"

    return result
