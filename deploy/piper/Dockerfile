FROM python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
WORKDIR /app
RUN pip install --no-cache-dir piper-tts==1.8.0 Flask==3.1.2 waitress==3.0.2
COPY download.py /app/download.py
RUN python /app/download.py
COPY app.py /app/app.py
RUN useradd --uid 10001 --create-home piper
USER piper
EXPOSE 8000
CMD ["waitress-serve", "--host=0.0.0.0", "--port=8000", "--threads=2", "--connection-limit=8", "--max-request-body-size=8192", "app:app"]
