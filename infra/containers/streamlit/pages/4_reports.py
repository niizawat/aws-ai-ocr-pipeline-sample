"""レポート閲覧 - 元レポートと構造化結果の並列表示"""

import os
import json

import boto3
import pandas as pd
import streamlit as st

st.set_page_config(page_title="レポート閲覧", page_icon="📄", layout="wide")
st.title("📄 レポート閲覧")
st.caption("アップロード済みレポートの元ファイルと AI 抽出結果を並列表示します。")

S3_BUCKET = os.environ.get("S3_BUCKET", "")
DYNAMODB_TABLE = os.environ.get("DYNAMODB_TABLE", "quality-report-reports")
AWS_REGION = os.environ.get("AWS_REGION", "ap-northeast-1")

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
table = dynamodb.Table(DYNAMODB_TABLE)
s3_client = boto3.client("s3", region_name=AWS_REGION)


@st.cache_data(ttl=60)
def list_reports() -> pd.DataFrame:
    """レポート一覧を取得する。"""
    items: list[dict] = []
    response = table.scan(
        ProjectionExpression="report_id, source_file, source_type, extracted_at, review_status, confidence_score",
    )
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = table.scan(
            ExclusiveStartKey=response["LastEvaluatedKey"],
            ProjectionExpression="report_id, source_file, source_type, extracted_at, review_status, confidence_score",
        )
        items.extend(response.get("Items", []))
    if not items:
        return pd.DataFrame()
    df = pd.DataFrame(items)
    if "report_id" in df.columns:
        df = df.drop_duplicates(subset=["report_id"])
    return df


reports_df = list_reports()

if reports_df.empty:
    st.info("レポートがまだ登録されていません。")
    st.stop()

st.subheader("レポート一覧")
selected_idx = st.dataframe(
    reports_df,
    use_container_width=True,
    hide_index=True,
    on_select="rerun",
    selection_mode="single-row",
)

selected_rows = selected_idx.selection.rows if selected_idx.selection else []
if not selected_rows:
    st.info("レポートを選択してください。")
    st.stop()

selected_report = reports_df.iloc[selected_rows[0]]
report_id = selected_report.get("report_id", "")

st.divider()
st.subheader(f"レポート詳細: {report_id}")

left_col, right_col = st.columns(2)

# 左ペイン: 元ファイル
with left_col:
    st.markdown("### 元ファイル")
    source_file = selected_report.get("source_file", "")
    if source_file and S3_BUCKET:
        try:
            presigned_url = s3_client.generate_presigned_url(
                "get_object",
                Params={"Bucket": S3_BUCKET, "Key": source_file},
                ExpiresIn=3600,
            )
            source_type = selected_report.get("source_type", "")
            if source_type == "pdf":
                st.markdown(f"[PDF をダウンロード]({presigned_url})")
            elif source_type in ("xlsx", "excel"):
                st.markdown(f"[Excel をダウンロード]({presigned_url})")

            images_prefix = f"images/{report_id}/"
            try:
                img_resp = s3_client.list_objects_v2(
                    Bucket=S3_BUCKET, Prefix=images_prefix, MaxKeys=10
                )
                for obj in img_resp.get("Contents", []):
                    img_url = s3_client.generate_presigned_url(
                        "get_object",
                        Params={"Bucket": S3_BUCKET, "Key": obj["Key"]},
                        ExpiresIn=3600,
                    )
                    st.image(img_url, caption=obj["Key"].split("/")[-1])
            except Exception:
                pass
        except Exception as e:
            st.error(f"ファイル取得エラー: {e}")
    else:
        st.warning("元ファイル情報がありません。")

# 右ペイン: 構造化結果
with right_col:
    st.markdown("### AI 抽出結果")
    detail_resp = table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("report_id").eq(report_id)
    )
    detail_items = detail_resp.get("Items", [])

    if not detail_items:
        st.warning("抽出結果がありません。")
    else:
        for item in detail_items:
            page_section = item.get("page_section", "")
            confidence = item.get("confidence_score", "N/A")
            status = item.get("review_status", "N/A")
            with st.expander(f"セクション: {page_section}（信頼度: {confidence}）"):
                st.json(
                    {
                        k: v
                        for k, v in item.items()
                        if k not in ("report_id", "page_section")
                    }
                )
                st.caption(f"ステータス: {status}")
