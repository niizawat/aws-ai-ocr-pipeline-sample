"""CodeBuild trigger is_complete handler.

Custom Resource Provider が定期的に呼び出し、CodeBuild 完了を判定する。
"""

import boto3


def handler(event, context):
    if event["RequestType"] == "Delete":
        return {"IsComplete": True}

    build_id = event["Data"]["BuildId"]
    codebuild = boto3.client("codebuild")
    build = codebuild.batch_get_builds(ids=[build_id])["builds"][0]
    status = build["buildStatus"]

    if status == "SUCCEEDED":
        return {"IsComplete": True, "Data": {"BuildId": build_id, "Status": status}}
    if status in {"FAILED", "FAULT", "STOPPED", "TIMED_OUT"}:
        raise RuntimeError(f"CodeBuild failed with status: {status}")

    return {"IsComplete": False}
