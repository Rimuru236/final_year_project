FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libmupdf-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    python -m spacy download en_core_web_sm

COPY . .

EXPOSE 8000
# WEB_CONCURRENCY controls worker count (defaults to 4) — each worker is a
# separate process with its own event loop, so blocking work in one no longer
# stalls requests being handled by the others. Scheduled jobs are guarded by
# a Mongo leader lock (app/core/leader_lock.py) so they still run exactly
# once regardless of worker count.
ENV WEB_CONCURRENCY=4
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY}"]
