from pathlib import Path
from urllib.request import urlretrieve

revision = 'e7229f7d33a10e145e109b886d661984201ac3c4'
root = Path('/models')
root.mkdir(exist_ok=True)
for language, locale, name, quality in [('en', 'en_US', 'ljspeech', 'medium'), ('ar', 'ar_JO', 'kareem', 'medium')]:
    voice = f'{locale}-{name}-{quality}'
    base = f'https://huggingface.co/rhasspy/piper-voices/resolve/{revision}/{language}/{locale}/{name}/{quality}'
    for suffix in ['.onnx', '.onnx.json']:
        urlretrieve(f'{base}/{voice}{suffix}', root / (voice + suffix))
    urlretrieve(f'{base}/MODEL_CARD', root / (voice + '.MODEL_CARD'))
