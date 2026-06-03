"""PDF ページ画像生成 Lambda: プレビュー用 PNG を images/{report_id}/ へ保存する。

scan-pdf 経路では LibreOffice 変換を通らないため、OCR 前に本 Lambda で
ページ画像を用意する（レポート閲覧 UI のオーバーレイ表示に使用）。
"""

from __future__ import annotations

from pathlib import Path

import boto3
import fitz  # PyMuPDF

s3 = boto3.client("s3")

# 約 144 DPI（OCR bbox との整合用）
_RENDER_MATRIX = fitz.Matrix(2.0, 2.0)


def handler(event, context):
    bucket = event["bucket"]
    key = event["key"]
    report_id = event["report_id"]

    workdir = Path("/tmp/render-pdf")
    workdir.mkdir(parents=True, exist_ok=True)
    pdf_path = workdir / "input.pdf"
    s3.download_file(bucket, key, str(pdf_path))

    image_prefix = f"images/{report_id}/"
    uploaded = 0

    with fitz.open(pdf_path) as doc:
        for page_index in range(len(doc)):
            page = doc.load_page(page_index)
            pix = page.get_pixmap(matrix=_RENDER_MATRIX, alpha=False)
            png_name = f"page-{page_index + 1:03d}.png"
            png_path = workdir / png_name
            pix.save(str(png_path))
            s3.upload_file(
                str(png_path),
                bucket,
                f"{image_prefix}{png_name}",
                ExtraArgs={"ContentType": "image/png"},
            )
            uploaded += 1

    return {
        **event,
        "imagePrefix": image_prefix,
        "imageCount": uploaded,
    }
