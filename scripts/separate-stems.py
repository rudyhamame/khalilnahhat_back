"""Separate a local recording with Demucs; all outputs retain one sample clock."""
import argparse
import json
import os
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from demucs.pretrained import get_model
from demucs.apply import apply_model


def report(stage):
    print(json.dumps({'stage': stage}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input')
    parser.add_argument('output')
    args = parser.parse_args()
    torch.set_num_threads(max(1, int(os.environ.get('STEM_THREADS', '2'))))
    report('Loading separation model')
    model = get_model('htdemucs').cpu().eval()
    report('Reading recording')
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', args.input,
        '-t', '601', '-f', 'f32le', '-ac', str(model.audio_channels), '-ar', str(model.samplerate), '-'], timeout=120)
    mix = torch.from_numpy(np.frombuffer(raw, dtype=np.float32).copy().reshape(-1, model.audio_channels).T)
    if mix.shape[-1] > model.samplerate * 600:
        raise ValueError('Choose a recording under 10 minutes.')
    reference = mix.mean(0)
    mean, std = reference.mean(), reference.std().clamp(min=1e-8)
    report('Separating vocals, drums, bass and other music')
    with torch.inference_mode():
        stems = apply_model(model, ((mix-mean)/std)[None], device='cpu',
            shifts=0, split=True, segment=3, overlap=.25, progress=True, num_workers=0)[0]
    stems = stems * std + mean / len(model.sources)
    # One common gain preserves the balance between stems and avoids clipping.
    stems /= max(1., float(stems.abs().max()) / .98)
    directory = Path(args.output)
    directory.mkdir(parents=True, exist_ok=True)
    report('Saving separated channels')
    for name, samples in zip(model.sources, stems):
        sf.write(directory / f'{name}.flac', samples.T.numpy(), model.samplerate, subtype='PCM_24')
    print(json.dumps({'stage':'complete', 'duration':mix.shape[-1]/model.samplerate,
        'sampleRate':model.samplerate, 'channels':list(model.sources)}), flush=True)


if __name__ == '__main__':
    main()
