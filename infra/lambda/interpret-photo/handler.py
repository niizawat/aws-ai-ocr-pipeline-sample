"""写真解釈 Lambda（Bedrock Kimi K2.5）

文字・表・グラフは PaddleOCR-VL が担うため、本 Lambda は「写真が示す事象の意味解釈」
のみを Bedrock の Kimi K2.5（マルチモーダル）で担う。

重要:
  Kimi K2.5 は画像入力に対応するが、Bedrock の Converse API では画像フィールドが
  ValidationException となるため、InvokeModel（OpenAI 互換スキーマ・image_url に
  base64 data URL）で呼び出す。画像ペイロード上限は 3MB。
  @see https://repost.aws/questions/QURcUmU5pcRHmj7sQKhhb3dA

入力（Step Functions ステート入力）:
  bucket, key, report_id

出力:
  {bucket, key, report_id, photoInterpretations:[{page, interpretation}]}
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os

import boto3

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("interpret_photo")

s3 = boto3.client("s3")
bedrock = boto3.client("bedrock-runtime")

MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "moonshotai.kimi-k2.5")
MAX_PAGES = int(os.environ.get("MAX_PAGES", "10"))
PDF_RENDER_DPI = int(os.environ.get("PDF_RENDER_DPI", "150"))
MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", str(3 * 1024 * 1024)))
MAX_OUTPUT_TOKENS = int(os.environ.get("MAX_OUTPUT_TOKENS", "1500"))

_PDF_MAGIC = b"%PDF-"

PROMPT = (
    "あなたは製造業の品質管理の専門家です。次の文書画像に含まれる写真・画像"
    "（不具合品・部品・外観など）について、何が写っているか、また不具合や異常の"
    "外観・部位・状態を、日本語で簡潔かつ客観的に説明してください。"
    "文書中の文字情報の書き起こしは不要です。"
    "写真・画像が含まれない場合は「写真なし」とだけ回答してください。"
)


def handler(event, context):
    bucket = event.get("bucket")
    key = event.get("key")
    report_id = event.get("report_id", "unknown")

    base = {"bucket": bucket, "key": key, "report_id": report_id}

    try:
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        images = _to_jpeg_images(body)
    except Exception as exc:  # noqa: BLE001 - 入力不正でも本処理を止めない
        logger.exception("Failed to load/rasterize input")
        return {**base, "photoInterpretations": [], "error": str(exc)}

    interpretations = []
    for page_index, jpeg in enumerate(images[:MAX_PAGES], start=1):
        try:
            text = _invoke_kimi(jpeg)
        except Exception as exc:  # noqa: BLE001 - 1 ページ失敗でも続行
            logger.exception("Kimi invocation failed on page %d", page_index)
            text = f"(解釈失敗: {exc})"
        interpretations.append({"page": page_index, "interpretation": text})

    return {**base, "photoInterpretations": interpretations}


def _to_jpeg_images(body: bytes) -> list[bytes]:
    if body[:5] == _PDF_MAGIC:
        return _rasterize_pdf(body)
    from PIL import Image

    image = Image.open(io.BytesIO(body)).convert("RGB")
    return [_encode_jpeg(image)]


def _rasterize_pdf(pdf_bytes: bytes) -> list[bytes]:
    import fitz  # PyMuPDF
    from PIL import Image

    out: list[bytes] = []
    with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
        for page in doc:
            pix = page.get_pixmap(dpi=PDF_RENDER_DPI)
            image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            out.append(_encode_jpeg(image))
    if not out:
        raise ValueError("PDF has no pages")
    return out


def _encode_jpeg(image) -> bytes:
    """3MB 以下になるよう、品質と解像度を段階的に下げて JPEG エンコードする。"""
    from PIL import Image

    quality = 85
    work = image
    for _ in range(8):
        buf = io.BytesIO()
        work.save(buf, format="JPEG", quality=quality, optimize=True)
        data = buf.getvalue()
        if len(data) <= MAX_IMAGE_BYTES:
            return data
        if quality > 50:
            quality -= 15
        else:
            new_size = (int(work.width * 0.8), int(work.height * 0.8))
            work = work.resize(new_size, Image.LANCZOS)
    return data


def _invoke_kimi(jpeg_bytes: bytes) -> str:
    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    request = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                    },
                ],
            }
        ],
        "max_tokens": MAX_OUTPUT_TOKENS,
        "temperature": 0,
    }
    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps(request),
        contentType="application/json",
        accept="application/json",
    )
    payload = json.loads(response["body"].read())
    return _extract_text(payload)


def _extract_text(payload: dict) -> str:
    """OpenAI 互換レスポンスから本文を抽出する（content が list の場合も考慮）。"""
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message", {})
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = [
                seg.get("text", "")
                for seg in content
                if isinstance(seg, dict) and seg.get("type") == "text"
            ]
            return "".join(parts).strip()
    # フォールバック（スキーマ差異に備える）
    if isinstance(payload.get("content"), str):
        return payload["content"].strip()
    return json.dumps(payload, ensure_ascii=False)
