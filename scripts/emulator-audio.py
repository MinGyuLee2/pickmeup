#!/usr/bin/env python3
"""Inject a short, synthetic WAV into this project's emulator. Never enables the host mic."""
import argparse
import os
from pathlib import Path
import sys
import time
import wave

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / '.local' / 'emulator-proto'))
import grpc
import emulator_controller_pb2 as pb
import emulator_controller_pb2_grpc as rpc
from google.protobuf.empty_pb2 import Empty

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('wav', type=Path)
parser.add_argument('--avd', default='PickMeUp_Pleos_2_1')
args = parser.parse_args()
discovery = Path.home() / 'Library/Caches/TemporaryItems/avd/running'
configs = []
for path in discovery.glob('pid_*.ini'):
    config = dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)
    if config.get('avd.name') != args.avd:
        continue
    try:
        os.kill(int(path.stem.split('_')[1]), 0)
    except (ValueError, ProcessLookupError):
        continue
    configs.append(config)
if len(configs) != 1:
    raise SystemExit('Expected exactly one live project AVD; start scripts/emulator.sh first.')
config = configs[0]
with wave.open(str(args.wav), 'rb') as audio:
    rate, frames = audio.getframerate(), audio.getnframes()
    if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or rate > 48000 or not 0 < frames/rate <= 30:
        raise SystemExit('Expected a 0–30 second mono PCM16 WAV at <=48kHz.')
    raw = bytes(rate // 2) + audio.readframes(frames) + bytes(rate * 2)
metadata = [('authorization', 'Bearer ' + config['grpc.token'])]
with grpc.insecure_channel('127.0.0.1:' + config['grpc.port']) as channel:
    stub = rpc.EmulatorControllerStub(channel)
    if stub.getMicrophoneState(Empty(), metadata=metadata, timeout=3).realAudioEnabled:
        raise SystemExit('Host microphone is enabled. Stop this test rather than mixing real host input.')
    packet_size = (rate // 50) * 2
    audio_format = pb.AudioFormat(samplingRate=rate, channels=pb.AudioFormat.Mono,
        format=pb.AudioFormat.AUD_FMT_S16, mode=pb.AudioFormat.MODE_UNSPECIFIED)
    def packets():
        for offset in range(0, len(raw), packet_size):
            yield pb.AudioPacket(format=audio_format, timestamp=time.time_ns() // 1000,
                audio=raw[offset:offset+packet_size])
    try:
        stub.injectAudio(packets(), metadata=metadata, timeout=frames/rate+8)
    except grpc.RpcError as error:
        raise SystemExit('Audio injection failed: ' + error.code().name) from None
print('Injected synthetic audio through authenticated localhost gRPC. Host microphone remains disabled.')
