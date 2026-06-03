"""
A2I セットアップ Custom Resource (CDK Provider)

HumanTaskUi / FlowDefinition を SageMaker API で作成する。
"""

import logging
import time

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sagemaker = boto3.client("sagemaker")

MAX_RETRIES = 10
RETRY_INTERVAL_SECONDS = 10


def _describe_human_task_ui(name: str) -> str | None:
    try:
        response = sagemaker.describe_human_task_ui(HumanTaskUiName=name)
        return response["HumanTaskUiArn"]
    except sagemaker.exceptions.ResourceNotFound:
        return None


def _create_human_task_ui(name: str, template_content: str) -> str:
    response = sagemaker.create_human_task_ui(
        HumanTaskUiName=name,
        UiTemplate={"Content": template_content},
    )
    return response["HumanTaskUiArn"]


def _wait_for_flow_definition(flow_definition_name: str) -> bool:
    for _ in range(MAX_RETRIES):
        response = sagemaker.describe_flow_definition(
            FlowDefinitionName=flow_definition_name
        )
        status = response.get("FlowDefinitionStatus", "")
        logger.info("FlowDefinition %s status: %s", flow_definition_name, status)
        if status == "Active":
            return True
        if status == "Failed":
            logger.error(
                "FlowDefinition failed: %s",
                response.get("FailureReason", "unknown"),
            )
            return False
        time.sleep(RETRY_INTERVAL_SECONDS)
    return False


def _describe_flow_definition(name: str) -> str | None:
    try:
        response = sagemaker.describe_flow_definition(FlowDefinitionName=name)
        if response.get("FlowDefinitionStatus") == "Active":
            return response["FlowDefinitionArn"]
        logger.info(
            "FlowDefinition %s exists but status is %s",
            name,
            response.get("FlowDefinitionStatus"),
        )
        return None
    except sagemaker.exceptions.ResourceNotFound:
        return None


def _create_flow_definition(props: dict, human_task_ui_arn: str) -> str:
    response = sagemaker.create_flow_definition(
        FlowDefinitionName=props["FlowDefinitionName"],
        HumanLoopConfig={
            "WorkteamArn": props["WorkteamArn"],
            "HumanTaskUiArn": human_task_ui_arn,
            "TaskTitle": props.get("TaskTitle", "Quality report OCR review"),
            "TaskDescription": props.get(
                "TaskDescription",
                "Review and correct AI-extracted quality report fields.",
            ),
            "TaskCount": 1,
            "TaskTimeLimitInSeconds": int(props.get("TaskTimeLimitInSeconds", 3600)),
        },
        OutputConfig={"S3OutputPath": props["S3OutputPath"]},
        RoleArn=props["RoleArn"],
    )
    flow_definition_arn = response["FlowDefinitionArn"]
    if not _wait_for_flow_definition(props["FlowDefinitionName"]):
        raise RuntimeError(
            f"FlowDefinition {props['FlowDefinitionName']} did not become Active"
        )
    return flow_definition_arn


def _ensure_a2i_resources(props: dict) -> dict:
    ui_name = props["HumanTaskUiName"]
    human_task_ui_arn = _describe_human_task_ui(ui_name)
    if human_task_ui_arn is None:
        logger.info("Creating HumanTaskUi %s", ui_name)
        human_task_ui_arn = _create_human_task_ui(
            ui_name, props["TaskTemplateContent"]
        )
    else:
        logger.info("Reusing HumanTaskUi %s", human_task_ui_arn)

    flow_name = props["FlowDefinitionName"]
    flow_definition_arn = _describe_flow_definition(flow_name)
    if flow_definition_arn is None:
        logger.info("Creating FlowDefinition %s", flow_name)
        flow_definition_arn = _create_flow_definition(props, human_task_ui_arn)
    else:
        logger.info("Reusing FlowDefinition %s", flow_definition_arn)

    return {
        "HumanTaskUiArn": human_task_ui_arn,
        "FlowDefinitionArn": flow_definition_arn,
    }


def handler(event, context):
    logger.info("Event: %s", event)
    request_type = event["RequestType"]
    physical_resource_id = event.get("PhysicalResourceId", "a2i-setup")

    if request_type == "Delete":
        return {
            "PhysicalResourceId": physical_resource_id,
            "Data": {},
        }

    props = event["ResourceProperties"]
    data = _ensure_a2i_resources(props)
    return {
        "PhysicalResourceId": data["FlowDefinitionArn"],
        "Data": data,
    }
