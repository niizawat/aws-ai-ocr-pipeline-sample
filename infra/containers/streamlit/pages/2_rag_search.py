"""RAG チャット検索 - S3 Vectors + Bedrock Claude + Titan Embeddings"""

import os
import json

import boto3
import streamlit as st

st.set_page_config(page_title="RAG チャット検索", page_icon="🔍", layout="wide")
st.title("🔍 RAG チャット検索")
st.caption("品質レポートの内容を自然言語で検索・質問できます。")

VECTOR_BUCKET = os.environ.get("VECTOR_BUCKET", "quality-reports-vectors")
VECTOR_INDEX = os.environ.get("VECTOR_INDEX", "report-embeddings")
AWS_REGION = os.environ.get("AWS_REGION", "ap-northeast-1")

bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION)
s3vectors = boto3.client("s3vectors", region_name=AWS_REGION)

if "rag_messages" not in st.session_state:
    st.session_state.rag_messages = []

for msg in st.session_state.rag_messages:
    st.chat_message(msg["role"]).write(msg["content"])

query = st.chat_input("品質レポートについて質問してください")
if query:
    st.session_state.rag_messages.append({"role": "user", "content": query})
    st.chat_message("user").write(query)

    with st.spinner("検索中..."):
        try:
            # 1. クエリをベクトル化 (Titan Embeddings V2)
            embed_resp = bedrock.invoke_model(
                modelId="amazon.titan-embed-text-v2:0",
                body=json.dumps({"inputText": query}),
            )
            query_vector = json.loads(embed_resp["body"].read())["embedding"]

            # 2. S3 Vectors で類似検索
            search_resp = s3vectors.query_vectors(
                vectorBucketName=VECTOR_BUCKET,
                indexName=VECTOR_INDEX,
                queryVector={"float32": query_vector},
                topK=10,
                returnMetadata=True,
            )

            vectors = search_resp.get("vectors", [])
            if not vectors:
                answer_text = "関連するレポートが見つかりませんでした。"
                st.session_state.rag_messages.append(
                    {"role": "assistant", "content": answer_text}
                )
                st.chat_message("assistant").write(answer_text)
                st.stop()

            context_parts = []
            references = []
            for v in vectors:
                meta = v.get("metadata", {})
                content = meta.get("content_text", "")
                if content:
                    context_parts.append(content)
                ref_id = meta.get("report_id", "不明")
                ref_date = meta.get("report_date", "")
                references.append(f"- レポート ID: {ref_id}（{ref_date}）")

            context = "\n---\n".join(context_parts)

            # 3. Bedrock Claude で回答生成
            answer_resp = bedrock.converse(
                modelId=os.environ.get(
                    "BEDROCK_CHAT_MODEL_ID", "us.anthropic.claude-sonnet-4-6"
                ),
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "text": (
                                    "あなたは製造業の品質管理の専門家です。"
                                    "以下の品質レポートデータに基づいて質問に回答してください。"
                                    "データに含まれない情報については「データに含まれていません」と回答してください。\n\n"
                                    f"## 参照データ\n{context}\n\n"
                                    f"## 質問\n{query}"
                                )
                            }
                        ],
                    }
                ],
            )
            answer_text = answer_resp["output"]["message"]["content"][0]["text"]

            unique_refs = list(dict.fromkeys(references))
            full_answer = f"{answer_text}\n\n**参照元:**\n" + "\n".join(
                unique_refs[:5]
            )

            st.session_state.rag_messages.append(
                {"role": "assistant", "content": full_answer}
            )
            st.chat_message("assistant").markdown(full_answer)

        except Exception as e:
            error_msg = f"検索中にエラーが発生しました: {e}"
            st.error(error_msg)
