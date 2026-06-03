"""CodeBuild trigger on_event handler.

aws-ocr-vision-lab と同じく、Custom Resource の onEvent で build を開始するだけ。
完了待ちは is_complete.py 側で行う。
"""

import boto3


def handler(event, context):
    request_type = event["RequestType"]
    if request_type == "Delete":
        return {"Data": {}}

    project_name = event["ResourceProperties"]["ProjectName"]
    codebuild = boto3.client("codebuild")
    response = codebuild.start_build(projectName=project_name)
    build_id = response["build"]["id"]
    return {"Data": {"BuildId": build_id}}
