"""BI ダッシュボード - 不具合件数推移、パレート図、対策完了率、OCR 処理ステータス"""

import os
import json
from datetime import datetime, timedelta

import boto3
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

st.set_page_config(page_title="ダッシュボード", page_icon="📊", layout="wide")
st.title("📊 ダッシュボード")

DYNAMODB_TABLE = os.environ.get("DYNAMODB_TABLE", "quality-report-reports")
AWS_REGION = os.environ.get("AWS_REGION", "ap-northeast-1")

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
table = dynamodb.Table(DYNAMODB_TABLE)


@st.cache_data(ttl=300)
def load_report_data() -> pd.DataFrame:
    """DynamoDB からレポートデータを取得し DataFrame に変換する。"""
    items: list[dict] = []
    response = table.scan()
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
        items.extend(response.get("Items", []))

    if not items:
        return pd.DataFrame()

    df = pd.DataFrame(items)
    if "extracted_at" in df.columns:
        df["extracted_at"] = pd.to_datetime(df["extracted_at"], errors="coerce")
        df["month"] = df["extracted_at"].dt.to_period("M").astype(str)
    return df


df = load_report_data()

if df.empty:
    st.info("レポートデータがまだ登録されていません。")
    st.stop()

# ----- KPI メトリクス -----
col1, col2, col3, col4 = st.columns(4)

total_reports = df["report_id"].nunique() if "report_id" in df.columns else 0
col1.metric("総レポート数", total_reports)

if "review_status" in df.columns:
    completed = len(df[df["review_status"] == "completed"])
    completion_rate = (completed / len(df) * 100) if len(df) > 0 else 0
    col2.metric("対策完了率", f"{completion_rate:.1f}%")

    pending_review = len(df[df["review_status"] == "pending_review"])
    col3.metric("レビュー待ち", pending_review)

if "confidence_score" in df.columns:
    df["confidence_score"] = pd.to_numeric(df["confidence_score"], errors="coerce")
    avg_confidence = df["confidence_score"].mean()
    col4.metric("平均信頼度", f"{avg_confidence:.2f}")

st.divider()

# ----- 不具合件数推移（月別） -----
chart_col1, chart_col2 = st.columns(2)

with chart_col1:
    st.subheader("不具合件数推移（月別）")
    if "month" in df.columns:
        monthly = df.groupby("month").size().reset_index(name="count")
        fig = px.bar(
            monthly,
            x="month",
            y="count",
            labels={"month": "月", "count": "件数"},
        )
        fig.update_layout(xaxis_tickangle=-45)
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.warning("日付データが不足しています。")

# ----- パレート図（不具合分類別） -----
with chart_col2:
    st.subheader("不具合分類（パレート）")
    if "defect_type" in df.columns:
        defect_counts = (
            df["defect_type"]
            .value_counts()
            .reset_index()
        )
        defect_counts.columns = ["defect_type", "count"]
        defect_counts = defect_counts.sort_values("count", ascending=False)
        defect_counts["cumulative_pct"] = (
            defect_counts["count"].cumsum() / defect_counts["count"].sum() * 100
        )

        fig = go.Figure()
        fig.add_trace(
            go.Bar(
                x=defect_counts["defect_type"],
                y=defect_counts["count"],
                name="件数",
            )
        )
        fig.add_trace(
            go.Scatter(
                x=defect_counts["defect_type"],
                y=defect_counts["cumulative_pct"],
                name="累積 %",
                yaxis="y2",
                mode="lines+markers",
            )
        )
        fig.update_layout(
            yaxis=dict(title="件数"),
            yaxis2=dict(title="累積 %", overlaying="y", side="right", range=[0, 105]),
            legend=dict(orientation="h", yanchor="bottom", y=1.02),
        )
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.warning("不具合分類データが不足しています。")

st.divider()

# ----- OCR 処理ステータス -----
st.subheader("OCR 処理ステータス")
if "review_status" in df.columns:
    status_counts = df["review_status"].value_counts().reset_index()
    status_counts.columns = ["status", "count"]
    fig = px.pie(
        status_counts,
        names="status",
        values="count",
        hole=0.4,
    )
    st.plotly_chart(fig, use_container_width=True)
