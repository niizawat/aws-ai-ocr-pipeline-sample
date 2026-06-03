"""Create model.tar.gz containing code/inference.py and upload to S3."""

from __future__ import annotations

import io
import tarfile
import boto3  # type: ignore[import-not-found]

s3 = boto3.client("s3")


def handler(event, context):
    req_type = event["RequestType"]
    props = event["ResourceProperties"]
    bucket = props["BucketName"]
    output_key = props.get("OutputKey", "model/model.tar.gz")

    if req_type == "Delete":
        return {"PhysicalResourceId": f"s3://{bucket}/{output_key}"}

    inference_code = props["InferenceCode"]
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w:gz") as tar:
        content = inference_code.encode("utf-8")
        info = tarfile.TarInfo(name="code/inference.py")
        info.size = len(content)
        tar.addfile(info, io.BytesIO(content))

    tar_buffer.seek(0)
    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=tar_buffer.getvalue(),
        ContentType="application/gzip",
    )

    return {
        "PhysicalResourceId": f"s3://{bucket}/{output_key}",
        "Data": {"ModelDataUrl": f"s3://{bucket}/{output_key}"},
    }
