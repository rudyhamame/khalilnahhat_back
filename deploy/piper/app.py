"""Private, bounded Piper TTS service for English and Arabic."""
import hmac
import io
import json
import os
import threading
import wave
from pathlib import Path

import onnxruntime as ort
from flask import Flask, Response, jsonify, request
from piper.config import PiperConfig
from piper.voice import PiperVoice

KEY = os.environ.get('TTS_API_KEY', '')
if len(KEY) < 32:
    raise RuntimeError('TTS_API_KEY must contain at least 32 characters')

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 8192
lock = threading.Lock()
voices = {}
for language, name in [('en', 'en_US-ljspeech-medium'), ('ar', 'ar_JO-kareem-medium')]:
    path = Path('/models') / (name + '.onnx')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    voices[language] = PiperVoice(
        session=ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider']),
        config=PiperConfig.from_dict(json.loads(Path(str(path) + '.json').read_text())),
    )

@app.before_request
def authorize():
    if request.path in ['/health', '/piper/health']:
        return None
    supplied = request.headers.get('Authorization', '').encode()
    if not hmac.compare_digest(supplied, ('Bearer ' + KEY).encode()):
        return jsonify(message='Unauthorized'), 401

@app.get('/health')
@app.get('/piper/health')
def health():
    return jsonify(ready=True, engine='piper', languages=['en', 'ar'], voice_cloning=False)

@app.post('/v1/audio/speech')
@app.post('/piper/v1/audio/speech')
def speech():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(message='A JSON object is required'), 400
    text = body.get('text')
    language = body.get('language', 'en')
    if not isinstance(text, str) or not text.strip() or len(text) > 600:
        return jsonify(message='Text must contain 1 to 600 characters'), 400
    if not isinstance(language, str) or language not in voices:
        return jsonify(message='Language must be en or ar'), 400
    if not lock.acquire(blocking=False):
        return jsonify(message='Speech generation is busy'), 503, {'Retry-After': '2'}
    try:
        output = io.BytesIO()
        with wave.open(output, 'wb') as wav:
            voices[language].synthesize_wav(text.strip(), wav)
        return Response(output.getvalue(), mimetype='audio/wav', headers={'Cache-Control': 'no-store'})
    except Exception:
        app.logger.error('Piper synthesis failed', exc_info=False)
        return jsonify(message='Speech generation failed'), 500
    finally:
        lock.release()
