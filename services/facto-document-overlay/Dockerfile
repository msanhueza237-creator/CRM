ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG CRM_REVISION
LABEL cl.latinchile.crm-revision=${CRM_REVISION} \
      cl.latinchile.facto-document-overlay="v1"
COPY --chown=app:app app/hub/worker.py /app/app/hub/worker.py
