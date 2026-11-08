#!/usr/bin/env python3
"""Conservative OVH housekeeping; dry run unless --apply is supplied."""
import argparse
import datetime as dt
import fcntl
import json
import pathlib
import re
import shutil
import subprocess


def run(args):
    return subprocess.check_output(args, text=True, timeout=180)


def container_rows():
    ids = run(['docker', 'ps', '-aq']).split()
    return json.loads(run(['docker', 'inspect', *ids])) if ids else []


def image_family(image):
    tags = ' '.join(image.get('RepoTags') or [])
    for family in ['portfolio', 'khalil', 'library', 'roku', 'cloudflared', 'mongo', 'caddy', 'echo-obs']:
        if family in tags:
            return family
    return tags.split(':')[0] or image['Id']


def candidates(images, containers, config_text, now):
    keep = {row['Image'] for row in containers}
    families = {}
    cutoff = now - dt.timedelta(days=30)
    for image in images:
        created = dt.datetime.fromisoformat(re.sub(r'(\.\d{6})\d+', r'\1', image['Created']).replace('Z', '+00:00'))
        if created >= cutoff or image['Id'] in config_text or any(tag in config_text for tag in image.get('RepoTags') or []):
            keep.add(image['Id'])
        families.setdefault(image_family(image), []).append(image)
    for rows in families.values():
        keep.update(row['Id'] for row in sorted(rows, key=lambda row: row['Created'], reverse=True)[:2])
    return [row for row in images if row['Id'] not in keep]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    with open('/run/lock/khalil-cleanup.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another cleanup is running; skipped.')
            return
        before = shutil.disk_usage('/').free
        containers = container_rows()
        if any(row['State'].get('Health', {}).get('Status') == 'unhealthy' for row in containers if row['State']['Running']):
            raise RuntimeError('A running service is unhealthy; cleanup skipped.')
        configs = set()
        for row in containers:
            labels = row['Config'].get('Labels') or {}
            configs.update(filter(None, labels.get('com.docker.compose.project.config_files', '').split(',')))
        config_text = '\n'.join(pathlib.Path(p).read_text() for p in configs if pathlib.Path(p).is_file())
        ids = sorted(set(run(['docker', 'image', 'ls', '-q', '--no-trunc']).split()))
        images = json.loads(run(['docker', 'image', 'inspect', *ids])) if ids else []
        selected = candidates(images, containers, config_text, dt.datetime.now(dt.timezone.utc))
        print(json.dumps({'mode': 'apply' if args.apply else 'dry-run', 'candidateImages': len(selected), 'freeBytesBefore': before}), flush=True)
        for image in selected:
            if image['Id'] in {row['Image'] for row in container_rows()}:
                continue
            print('Old unused image:', ', '.join(image.get('RepoTags') or [image['Id']]), flush=True)
            if args.apply:
                # Never force removal: Docker fences images newly claimed by a container.
                result = subprocess.run(['docker', 'image', 'rm', *(image.get('RepoTags') or [image['Id']])], capture_output=True, text=True, timeout=180)
                print('Removed' if result.returncode == 0 else 'Retained: Docker rejected removal', flush=True)
        commands = [
            ['docker', 'builder', 'prune', '--all', '--force', '--filter', 'until=336h', '--keep-storage', '256MB'],
            ['journalctl', '--rotate'],
            ['journalctl', '--vacuum-time=14d', '--vacuum-size=200M'],
        ]
        for command in commands:
            print('Housekeeping:', ' '.join(command), flush=True)
            if args.apply:
                subprocess.run(command, check=True, timeout=300)
        print(json.dumps({'freeBytesAfter': shutil.disk_usage('/').free, 'reclaimedBytes': shutil.disk_usage('/').free - before}), flush=True)


if __name__ == '__main__':
    main()
