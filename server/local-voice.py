"""CPU speaker embeddings. Audio is received on stdin and never written to disk."""
import base64
import hashlib
import json
import os
import sys


def run():
    import numpy as np
    import sherpa_onnx

    model_path = os.environ['VOICE_LOCAL_MODEL']
    expected = os.environ['VOICE_LOCAL_MODEL_SHA256'].lower()
    with open(model_path, 'rb') as model_file:
        if hashlib.file_digest(model_file, 'sha256').hexdigest() != expected:
            raise ValueError('声音模型校验失败。')
    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=model_path, num_threads=2, debug=False, provider='cpu')
    if not config.validate():
        raise ValueError('声音模型配置无效。')
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    request = json.loads(sys.stdin.buffer.read(1500000))
    if request.get('probe'):
        return {'ok': True, 'dimension': extractor.dim}
    samples = np.frombuffer(base64.b64decode(request['pcm'], validate=True), dtype='<i2').astype(np.float32) / 32768
    if not 32000 <= samples.size <= 480000:
        raise ValueError('请提供 2–30 秒单人语音。')
    frames = samples[:samples.size // 320 * 320].reshape(-1, 320)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    cutoff = max(.003, min(.02, float(np.percentile(rms, 20)) * 1.8))
    active = rms > cutoff
    speech_ms = int(np.sum(active) * 20)
    clipping = float(np.mean(np.abs(samples) >= .995))
    if speech_ms < 2000 or clipping > .02:
        raise ValueError('有效讲话不足或声音失真，请靠近并连续单独讲话。')
    speech = np.ascontiguousarray(frames[active].reshape(-1))

    def embedding(audio):
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=16000, waveform=audio)
        stream.input_finished()
        if not extractor.is_ready(stream):
            raise ValueError('声音采样不足。')
        value = np.asarray(extractor.compute(stream), dtype=np.float32)
        norm = float(np.linalg.norm(value))
        if not norm or not np.all(np.isfinite(value)):
            raise ValueError('声音特征无效。')
        return value / norm

    value = embedding(speech)
    # A consistency screen, not a certified overlap detector. Sequential speech
    # is a product requirement; short/uncertain samples cannot update profiles.
    consistency = 1.0
    if speech.size >= 64000:
        consistency = float(np.dot(embedding(speech[:32000]), embedding(speech[-32000:])))
    stable = consistency >= float(os.environ.get('VOICE_WINDOW_CONSISTENCY', '.55'))
    return {'model': os.environ['VOICE_MODEL'], 'embedding': value.tolist(),
            'quality': {'usable': stable, 'singleSpeaker': stable, 'overlap': None,
                        'overlapChecked': False, 'scope': 'sequential-speech',
                        'speechMs': speech_ms, 'windowConsistency': consistency}}


if __name__ == '__main__':
    try:
        print(json.dumps(run(), ensure_ascii=True, allow_nan=False))
    except Exception:
        # No audio, features, credential values, file paths or library tracebacks.
        print(json.dumps({'error': '声音推理未完成：请检查模型环境，并使用清晰的连续单人语音。'}))
        sys.exit(1)
