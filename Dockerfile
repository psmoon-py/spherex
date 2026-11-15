# API server for Six Months Apart (FastAPI + Astropy). Runs on any container host; see render.yaml.
FROM python:3.12-slim
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH PYTHONUNBUFFERED=1
WORKDIR $HOME/app
COPY --chown=user backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir --user -r backend/requirements.txt
COPY --chown=user backend backend
COPY --chown=user presets.json presets.json
WORKDIR $HOME/app/backend
EXPOSE 7860
# Hosts such as Render pass the port in $PORT.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-7860}"]
