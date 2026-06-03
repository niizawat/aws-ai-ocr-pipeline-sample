# aws-ocr-vision-lab の PP-StructureV3 と同じビルド内容。
# 参照: packages/common/constructs/src/core/ocr-image-builder.ts
ARG REGION=us-east-1
FROM 763104351884.dkr.ecr.${REGION}.amazonaws.com/pytorch-inference:2.2.0-gpu-py310-cu118-ubuntu20.04-sagemaker

WORKDIR /opt/ml/code
ENV PADDLEOCR_HOME=/opt/ml/code/.paddleocr
ENV PYTHONUNBUFFERED=1

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

# Install PaddlePaddle GPU
RUN pip install --upgrade pip && \
    pip install paddlepaddle-gpu==3.2.2 -i https://www.paddlepaddle.org.cn/packages/stable/cu118/

# Install PaddleOCR
RUN pip install "paddleocr[all]"

EXPOSE 8080
