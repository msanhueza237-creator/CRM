ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG CRM_REVISION
LABEL cl.latinchile.crm-revision=${CRM_REVISION}
COPY --chown=app:app app/crm/http.py /app/app/crm/http.py
COPY --chown=app:app app/prospecting/contracts.py /app/app/prospecting/contracts.py
COPY --chown=app:app app/prospecting/sources.py /app/app/prospecting/sources.py
COPY --chown=app:app app/prospecting/deepseek_discovery.py /app/app/prospecting/deepseek_discovery.py
