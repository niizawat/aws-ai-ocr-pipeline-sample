"""PP-StructureV3 inference handler for SageMaker PyTorch DLC.

aws-ocr-vision-lab の PP-StructureV3 実装方針に合わせて、PaddleOCR を
SageMaker の model.tar.gz + inference.py 方式で実行する。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from typing import Any

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
os.environ["PADDLEOCR_HOME"] = "/opt/ml/code/.paddleocr"
os.environ["PADDLE_PDX_PDF_RENDER_SCALE"] = "2.0"


def model_fn(model_dir: str) -> dict[str, Any]:
    logger.info("Loading PP-StructureV3 model...")
    from paddleocr import PPStructureV3

    model = PPStructureV3(
        text_recognition_model_name="PP-OCRv5_server_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
    )
    return {"model": model}


def input_fn(request_body: bytes, content_type: str | None = None) -> dict[str, Any]:
    # 既存 pipeline 互換: invokeEndpointAsync が渡す入力ファイル実体（image/pdf bytes）
    if isinstance(request_body, str):
        request_body = request_body.encode("utf-8")

    # オプションで JSON も受ける（参照実装互換）
    if content_type == "application/json":
        return {"json_input": json.loads(request_body.decode("utf-8"))}

    return {"raw_bytes": request_body}


def predict_fn(input_data: dict[str, Any], model_artifacts: dict[str, Any]) -> dict[str, Any]:
    model = model_artifacts["model"]

    if "json_input" in input_data:
        raise ValueError("JSON input mode is not enabled in this endpoint")

    raw = input_data["raw_bytes"]
    suffix = ".pdf" if raw[:5] == b"%PDF-" else ".png"

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name

    try:
        results = model.predict(input=tmp_path)
        return _format_output(results)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _format_output(results: list[Any]) -> dict[str, Any]:
    regions: list[dict[str, Any]] = []
    markdown_parts: list[str] = []
    scores: list[float] = []
    # bbox はページ画像のピクセル絶対座標。オーバーレイ表示用に
    # ページ毎の width/height を保持し、表示画像へスケールできるようにする。
    page_sizes: list[dict[str, Any]] = []

    for page_index, res in enumerate(results, start=1):
        if not hasattr(res, "json"):
            continue
        res_json = res.json
        res_data = res_json.get("res", res_json)
        page_width = res_data.get("width")
        page_height = res_data.get("height")
        page_sizes.append(
            {"page": page_index, "width": page_width, "height": page_height}
        )
        parsing_list = res_data.get("parsing_res_list", [])
        for idx, block in enumerate(parsing_list):
            block_content = block.get("block_content", "")
            block_label = block.get("block_label", "text")
            block_bbox = block.get("block_bbox") or block.get("bbox")
            region = {
                "regionId": f"page{page_index}-{idx}",
                "page": page_index,
                "blockLabel": block_label,
                "text": block_content,
                "bbox": block_bbox,
                "pageWidth": page_width,
                "pageHeight": page_height,
            }
            regions.append(region)
            if block_label == "doc_title":
                markdown_parts.append(f"# {block_content}")
            elif block_label == "paragraph_title":
                markdown_parts.append(f"## {block_content}")
            else:
                markdown_parts.append(block_content)

        layout_boxes = (res_data.get("layout_det_res") or {}).get("boxes", [])
        for box in layout_boxes:
            score = box.get("score")
            if isinstance(score, (int, float)):
                scores.append(float(score))

    confidence = round(sum(scores) / len(scores), 4) if scores else 0.0
    for region in regions:
        region["confidence"] = confidence

    return {
        "success": True,
        "model": "pp-structurev3",
        "pages": len(results),
        "confidence": confidence,
        "regions": regions,
        "pageSizes": page_sizes,
        "markdown": "\n\n".join(markdown_parts),
        "results": [r.json for r in results if hasattr(r, "json")],
    }


def output_fn(prediction: dict[str, Any], accept: str | None = None) -> bytes:
    return json.dumps(prediction, ensure_ascii=False).encode("utf-8")
