"""Private English/Arabic TTS API. Voice references are managed by the server owner."""
import hmac
import io
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import soundfile as sf
import torch
from chatterbox.mtl_tts import ChatterboxMultilingualTTS
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from typing import Literal

model = None
busy = threading.Lock()

@asynccontextmanager
async def lifespan(app):
    global model
    if len(os.environ.get('TTS_API_KEY', '')) < 32:
        raise RuntimeError('Set a random TTS_API_KEY of at least 32 characters')
    if not torch.cuda.is_available():
        raise RuntimeError('This deployment requires an NVIDIA GPU; CPU fallback is disabled')
    model = ChatterboxMultilingualTTS.from_pretrained(device='cuda', t3_model='v3')
    yield
    model = None

app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

def authorize(authorization: str = Header(default='')):
    expected = 'Bearer ' + os.environ['TTS_API_KEY']
    if not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(401, 'Unauthorized')

class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    language: Literal['en', 'ar'] = 'en'
    voice: Literal['default', 'echo'] = 'default'

@app.get('/health')
def health():
    return {'ready': model is not None, 'device': 'cuda', 'languages': ['en', 'ar'],
            'echo_voice_ready': Path('/voices/echo.wav').is_file()}

@app.post('/v1/audio/speech', dependencies=[Depends(authorize)])
def speech(request: SpeechRequest):
    if not request.text.strip():
        raise HTTPException(422, 'Text must not be blank')
    reference = '/voices/echo.wav' if request.voice == 'echo' else None
    if reference and not Path(reference).is_file():
        raise HTTPException(409, 'The Echo voice reference has not been configured')
    if not busy.acquire(blocking=False):
        raise HTTPException(503, 'Speech generation is busy', headers={'Retry-After': '3'})
    try:
        with torch.inference_mode():
            wav = model.generate(request.text, language_id=request.language, audio_prompt_path=reference)
        output = io.BytesIO()
        sf.write(output, wav.detach().cpu().numpy().reshape(-1), model.sr, format='WAV', subtype='PCM_16')
        return Response(output.getvalue(), media_type='audio/wav', headers={'Cache-Control': 'no-store'})
    finally:
        busy.release()
