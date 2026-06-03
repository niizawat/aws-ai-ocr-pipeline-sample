#!/bin/bash
set -euo pipefail

: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_KEY:?S3_KEY is required}"
: "${REPORT_ID:?REPORT_ID is required}"

WORKDIR="/tmp/work"
mkdir -p "${WORKDIR}"

INPUT_FILE="${WORKDIR}/$(basename "${S3_KEY}")"
aws s3 cp "s3://${S3_BUCKET}/${S3_KEY}" "${INPUT_FILE}"

libreoffice --headless --convert-to png --outdir "${WORKDIR}" "${INPUT_FILE}"

OUTPUT_PREFIX="images/${REPORT_ID}"
for png in "${WORKDIR}"/*.png; do
  [ -f "${png}" ] || continue
  FILENAME=$(basename "${png}")
  aws s3 cp "${png}" "s3://${S3_BUCKET}/${OUTPUT_PREFIX}/${FILENAME}"
done

rm -rf "${WORKDIR}"
echo "Conversion complete for ${REPORT_ID}"
