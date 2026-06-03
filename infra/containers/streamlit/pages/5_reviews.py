"""レビュー管理 - A2I レビュー待ち一覧と結果確認"""

import os
from datetime import datetime

import boto3
import pandas as pd
import streamlit as st

st.set_page_config(page_title="レビュー管理", page_icon="✅", layout="wide")
st.title("✅ レビュー管理")
st.caption("A2I Human Review の状況を確認・管理します。")

DYNAMODB_TABLE = os.environ.get("DYNAMODB_TABLE", "quality-report-reports")
AWS_REGION = os.environ.get("AWS_REGION", "ap-northeast-1")

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
table = dynamodb.Table(DYNAMODB_TABLE)
a2i_client = boto3.client("sagemaker", region_name=AWS_REGION)

tab_pending, tab_completed = st.tabs(["レビュー待ち", "レビュー完了"])

# ----- レビュー待ち -----
with tab_pending:
    st.subheader("レビュー待ちレポート")

    try:
        pending_resp = table.query(
            IndexName="status-index",
            KeyConditionExpression=boto3.dynamodb.conditions.Key("review_status").eq(
                "pending_review"
            ),
        )
        pending_items = pending_resp.get("Items", [])

        if not pending_items:
            st.info("レビュー待ちのレポートはありません。")
        else:
            pending_df = pd.DataFrame(pending_items)
            display_cols = [
                c
                for c in [
                    "report_id",
                    "page_section",
                    "source_file",
                    "confidence_score",
                    "extracted_at",
                ]
                if c in pending_df.columns
            ]
            st.dataframe(pending_df[display_cols], use_container_width=True, hide_index=True)

            st.markdown(f"**合計: {len(pending_items)} 件**")

    except Exception as e:
        st.error(f"データ取得エラー: {e}")

    st.divider()
    st.subheader("A2I Human Loop 一覧")
    flow_definition_arn = os.environ.get("FLOW_DEFINITION_ARN", "")

    if flow_definition_arn:
        try:
            loops_resp = a2i_client.list_human_loops(
                FlowDefinitionArn=flow_definition_arn,
                SortOrder="Descending",
                MaxResults=20,
            )
            loops = loops_resp.get("HumanLoopSummaries", [])
            if loops:
                loops_data = []
                for loop in loops:
                    loops_data.append(
                        {
                            "Loop 名": loop.get("HumanLoopName", ""),
                            "ステータス": loop.get("HumanLoopStatus", ""),
                            "作成日時": str(loop.get("CreationTime", "")),
                        }
                    )
                st.dataframe(pd.DataFrame(loops_data), use_container_width=True, hide_index=True)
            else:
                st.info("アクティブな Human Loop はありません。")
        except Exception as e:
            st.warning(f"A2I API 呼び出しエラー: {e}")
    else:
        st.warning("FLOW_DEFINITION_ARN 環境変数が設定されていません。")

# ----- レビュー完了 -----
with tab_completed:
    st.subheader("レビュー完了レポート")

    try:
        completed_resp = table.query(
            IndexName="status-index",
            KeyConditionExpression=boto3.dynamodb.conditions.Key("review_status").eq(
                "human_reviewed"
            ),
        )
        completed_items = completed_resp.get("Items", [])

        if not completed_items:
            st.info("レビュー完了のレポートはありません。")
        else:
            completed_df = pd.DataFrame(completed_items)
            display_cols = [
                c
                for c in [
                    "report_id",
                    "page_section",
                    "source_file",
                    "confidence_score",
                    "review_status",
                    "extracted_at",
                ]
                if c in completed_df.columns
            ]
            st.dataframe(completed_df[display_cols], use_container_width=True, hide_index=True)
            st.markdown(f"**合計: {len(completed_items)} 件**")

    except Exception as e:
        st.error(f"データ取得エラー: {e}")
