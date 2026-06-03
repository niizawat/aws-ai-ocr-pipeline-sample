FROM public.ecr.aws/ubuntu/ubuntu:24.04

# Ubuntu 24.04 では apt の awscli が提供されないため、AWS CLI v2 を公式インストーラで導入する
# https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libreoffice-calc \
      libreoffice-impress \
      libreoffice-draw \
      fonts-noto-cjk \
      ca-certificates \
      curl \
      unzip \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
