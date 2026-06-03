"""PDF テキスト抽出 Lambda: pypdf でデジタル PDF からテキストを取得"""

import json
import os
import io
import boto3

s3 = boto3.client("s3")


def handler(event, context):
    bucket = event["bucket"]
    key = event["key"]
    report_id = event["report_id"]

    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"].read()

    try:
        from pypdf import PdfReader
    except ImportError:
        return {
            "bucket": bucket,
            "key": key,
            "report_id": report_id,
            "error": "pypdf not available",
            "extractionType": "pdf-text",
        }

    reader = PdfReader(io.BytesIO(body))
    pages = []
    full_text = []

    for i, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        pages.append({"pageNumber": i + 1, "text": text})
        full_text.append(text)

    return {
        "bucket": bucket,
        "key": key,
        "report_id": report_id,
        "extractionType": "pdf-text",
        "pages": pages,
        "fullText": "\n".join(full_text),
        "pageCount": len(pages),
    }
