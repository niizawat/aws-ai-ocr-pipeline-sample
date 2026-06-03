"""埋め込みインデックス Lambda: 結果 JSON を Bedrock Titan Embed でベクトル化し S3 Vectors に書き込む"""

import json
import os
import boto3

REPORT_BUCKET = os.environ["REPORT_BUCKET"]
VECTOR_BUCKET = os.environ["VECTOR_BUCKET"]
VECTOR_INDEX = os.environ.get("VECTOR_INDEX", "report-embeddings")
EMBED_MODEL_ID = os.environ.get("BEDROCK_EMBED_MODEL_ID", "amazon.titan-embed-text-v2:0")

s3 = boto3.client("s3")
bedrock = boto3.client("bedrock-runtime")
s3vectors = boto3.client("s3vectors")

_BATCH_SIZE = 100
_MAX_CONTENT_CHARS = 8000  # Titan Embeddings V2 の入力上限に合わせたトリム
# S3 Vectors: filterable metadata はレコードあたり最大 2048 バイト（UTF-8）
_FILTERABLE_METADATA_MAX_BYTES = 2048


def _embed(text: str) -> list[float]:
    resp = bedrock.invoke_model(
        modelId=EMBED_MODEL_ID,
        body=json.dumps({"inputText": text[:_MAX_CONTENT_CHARS]}),
        contentType="application/json",
        accept="application/json",
    )
    return json.loads(resp["body"].read())["embedding"]


def _content_to_text(content) -> str:
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False)


def _metadata_byte_size(metadata: dict) -> int:
    return len(json.dumps(metadata, ensure_ascii=False).encode("utf-8"))


def _truncate_utf8(text: str, max_bytes: int) -> str:
    if max_bytes <= 0:
        return ""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    return encoded[:max_bytes].decode("utf-8", errors="ignore").rstrip()


def _build_filterable_metadata(
    report_id: str,
    report_date: str,
    source_file: str,
    content_text: str,
) -> dict:
    """S3 Vectors の filterable metadata 上限（2048 bytes）に収める。"""
    source_name = source_file.rsplit("/", 1)[-1] if source_file else ""
    metadata = {
        "report_id": report_id,
        "report_date": report_date,
        "source_file": source_name,
        "content_text": "",
    }
    fixed_size = _metadata_byte_size(metadata)
    if fixed_size >= _FILTERABLE_METADATA_MAX_BYTES:
        return {
            "report_id": report_id,
            "report_date": report_date,
            "content_text": "",
        }

    remaining = _FILTERABLE_METADATA_MAX_BYTES - fixed_size
    metadata["content_text"] = _truncate_utf8(content_text, remaining)

    while (
        metadata["content_text"]
        and _metadata_byte_size(metadata) > _FILTERABLE_METADATA_MAX_BYTES
    ):
        content = metadata["content_text"]
        metadata["content_text"] = content[: max(0, len(content) - max(1, len(content) // 10))]

    return metadata


def handler(event, context):
    report_id = event.get("report_id", "unknown")
    result_key = event.get("resultKey", f"results/{report_id}/result.json")

    obj = s3.get_object(Bucket=REPORT_BUCKET, Key=result_key)
    normalized = json.loads(obj["Body"].read())

    sections = normalized.get("sections", [])
    report_date = (normalized.get("extractedAt") or "")[:10]

    vectors = []
    for section in sections:
        content_text = _content_to_text(section.get("content", ""))
        if not content_text.strip():
            continue

        section_id = section.get("sectionId", "unknown")
        embedding = _embed(content_text)

        vectors.append({
            "key": f"{report_id}_{section_id}",
            "data": {"float32": embedding},
            "metadata": _build_filterable_metadata(
                report_id,
                report_date,
                str(normalized.get("sourceFile", "")),
                content_text,
            ),
        })

    for i in range(0, len(vectors), _BATCH_SIZE):
        s3vectors.put_vectors(
            vectorBucketName=VECTOR_BUCKET,
            indexName=VECTOR_INDEX,
            vectors=vectors[i : i + _BATCH_SIZE],
        )

    return {**event, "vectorsIndexed": len(vectors)}
