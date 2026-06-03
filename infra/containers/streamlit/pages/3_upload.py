"""レポートアップロード - S3 presigned URL を使用した Excel/PDF アップロード"""

import os
import uuid
from datetime import datetime

import boto3
import streamlit as st

st.set_page_config(page_title="レポートアップロード", page_icon="📤", layout="wide")
st.title("📤 レポートアップロード")
st.caption("品質レポート（Excel / PDF）をアップロードします。")

S3_BUCKET = os.environ.get("S3_BUCKET", "")
AWS_REGION = os.environ.get("AWS_REGION", "ap-northeast-1")

s3_client = boto3.client("s3", region_name=AWS_REGION)

uploaded_files = st.file_uploader(
    "Excel (.xlsx) または PDF (.pdf) ファイルを選択してください",
    type=["xlsx", "pdf"],
    accept_multiple_files=True,
)

if uploaded_files:
    st.subheader("アップロード対象ファイル")

    for uploaded_file in uploaded_files:
        file_size_kb = uploaded_file.size / 1024
        st.write(f"- **{uploaded_file.name}** ({file_size_kb:.1f} KB)")

    if st.button("アップロード実行", type="primary"):
        if not S3_BUCKET:
            st.error("S3_BUCKET 環境変数が設定されていません。")
            st.stop()

        progress = st.progress(0)
        results = []

        for i, uploaded_file in enumerate(uploaded_files):
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            file_id = str(uuid.uuid4())[:8]
            s3_key = f"raw/{timestamp}_{file_id}_{uploaded_file.name}"

            try:
                s3_client.upload_fileobj(
                    uploaded_file,
                    S3_BUCKET,
                    s3_key,
                    ExtraArgs={"ContentType": uploaded_file.type or "application/octet-stream"},
                )
                results.append({"name": uploaded_file.name, "key": s3_key, "success": True})
            except Exception as e:
                results.append({"name": uploaded_file.name, "key": s3_key, "success": False, "error": str(e)})

            progress.progress((i + 1) / len(uploaded_files))

        st.divider()
        st.subheader("アップロード結果")
        for r in results:
            if r["success"]:
                st.success(f"✅ {r['name']} → `s3://{S3_BUCKET}/{r['key']}`")
            else:
                st.error(f"❌ {r['name']}: {r.get('error', '不明なエラー')}")
