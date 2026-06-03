"""品質レポート分析基盤 - メインエントリポイント"""

import streamlit as st

st.set_page_config(
    page_title="品質レポート分析基盤",
    page_icon="📊",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.title("品質レポート分析基盤")
st.markdown(
    """
    製造品質レポート（Excel / PDF）の OCR 解析結果を可視化し、
    自然言語による横断検索を提供する PoC プラットフォームです。

    左のサイドバーからページを選択してください。

    | ページ | 機能 |
    |--------|------|
    | ダッシュボード | 不具合件数推移・パレート図・対策完了率 |
    | RAG チャット検索 | Bedrock Claude + S3 Vectors による自然言語検索 |
    | レポートアップロード | Excel / PDF を S3 にアップロード |
    | レポート閲覧 | 元レポートと構造化結果の並列表示 |
    | レビュー管理 | A2I レビュー待ち一覧・結果確認 |
    """
)
