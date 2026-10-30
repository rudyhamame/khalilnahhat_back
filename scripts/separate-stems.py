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
    torch.set_num_threads(max(1, int(os.environ.get('STEM_THREADS', '1'))))
    report('Loading separation model')
    model = get_model('htdemucs').cpu().eval()
    # HTDemucs otherwise pads even short windows to its training length,
    # defeating the segment memory bound. Use its supported variable-length mode.
    for network in getattr(model, 'models', [model]):
        if hasattr(network, 'use_train_segment'):
            network.use_train_segment = False
    report('Reading recording')
    directory = Path(args.output)
    directory.mkdir(parents=True, exist_ok=True)
    decoded = directory / 'decoded.wav'
    temporary = [directory / f'{name}.working.wav' for name in model.sources]
    try:
        # Decode to disk, not a full-length subprocess byte buffer plus tensors.
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-v', 'error', '-i', args.input,
            '-t', '601', '-acodec', 'pcm_f32le', '-ac', str(model.audio_channels),
            '-ar', str(model.samplerate), str(decoded)], check=True, timeout=120)
        with sf.SoundFile(decoded) as source:
            frames, rate = len(source), source.samplerate
            if frames == 0 or frames > rate * 600:
                raise ValueError('Choose a non-empty recording under 10 minutes.')
            # Keep one normalization for the whole recording without retaining it.
            total = square = 0.0
            for block in source.blocks(blocksize=rate, dtype='float32', always_2d=True):
                mono = block.mean(axis=1, dtype=np.float64)
                total += float(mono.sum())
                square += float(np.square(mono).sum())
            mean = total / frames
            std = max(1e-8, (max(0.0, square / frames - mean * mean)) ** .5)
            writers = []
            peak = 0.0
            try:
                for target in temporary:
                    writers.append(sf.SoundFile(target, mode='w', samplerate=rate,
                        channels=model.audio_channels, subtype='FLOAT'))
                chunk, context = rate * 12, rate * 2
                for begin in range(0, frames, chunk):
                    end = min(frames, begin + chunk)
                    left, right = max(0, begin-context), min(frames, end+context)
                    source.seek(left)
                    samples = source.read(right-left, dtype='float32', always_2d=True)
                    mix = torch.from_numpy(samples.T.copy())
                    report(f'Separating channels ({int(begin / frames * 100)}%)')
                    with torch.inference_mode():
                        stems = apply_model(model, ((mix-mean)/std)[None], device='cpu',
                            shifts=0, split=True, segment=3, overlap=.25,
                            progress=False, num_workers=0)[0]
                        stems.mul_(std).add_(mean / len(model.sources))
                    # Context reduces block-edge artifacts; write only the central
                    # samples, once, so every channel retains the original clock.
                    central = stems[:, :, begin-left:end-left]
                    peak = max(peak, float(central.abs().max()))
                    for writer, channel in zip(writers, central):
                        writer.write(channel.T.numpy())
                    del central, stems, mix, samples
            finally:
                for writer in writers:
                    writer.close()
        report('Saving separated channels')
        gain = max(1.0, peak / .98)
        for name, target in zip(model.sources, temporary):
            with sf.SoundFile(target) as source, sf.SoundFile(
                    directory / f'{name}.flac', mode='w', samplerate=rate,
                    channels=model.audio_channels, subtype='PCM_24') as output:
                for block in source.blocks(blocksize=rate, dtype='float32', always_2d=True):
                    output.write(block / gain)
    finally:
        decoded.unlink(missing_ok=True)
        for target in temporary:
            target.unlink(missing_ok=True)
    print(json.dumps({'stage':'complete', 'duration':frames/rate,
        'sampleRate':model.samplerate, 'channels':list(model.sources)}), flush=True)


if __name__ == '__main__':
    main()
