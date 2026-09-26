# Builds a tiny stand-in for Xenova/clip-vit-base-patch32 in the same file layout, for the e2e test.
# Not a real model: an image's embedding is its average colour (red → "sunset", green → "forest",
# blue → "ocean" dimensions) and a text's embedding is the one-hot of its highest token id, so
# each label prompt lands on its keyword's dimension. Enough to drive the real Transformers.js +
# ONNX Runtime pipeline end to end with predictable answers.   python3 make.py  (needs `onnx`)
import json, numpy as np, onnx
from onnx import helper, TensorProto, numpy_helper

generic = "a photo of the an with or group people young view from window at on in playing trees sunrise stage performance famous landmark, temple phone screen receipt object blurry room".split()
keywords = "selfie baby dog cat meal coffee cake beach ocean mountains forest flowers sunset night street snow palace car airplane party wedding concert sports painting screenshot document".split()
vocab = {"<unk>": 0, "<|endoftext|>": 1}
for w in generic: vocab.setdefault(w, len(vocab))
for i, w in enumerate(keywords): vocab[w] = 100 + i
D = 512

W = np.zeros((3, D), dtype=np.float32)
W[0, vocab["sunset"]] = W[1, vocab["forest"]] = W[2, vocab["ocean"]] = 1
g = helper.make_graph([helper.make_node('ReduceMean', ['pixel_values', 'axes'], ['m'], keepdims=0), helper.make_node('MatMul', ['m', 'W'], ['image_embeds'])],
  'vision', [helper.make_tensor_value_info('pixel_values', TensorProto.FLOAT, ['b', 3, 224, 224])], [helper.make_tensor_value_info('image_embeds', TensorProto.FLOAT, ['b', D])],
  [numpy_helper.from_array(W, 'W'), numpy_helper.from_array(np.array([2, 3], dtype=np.int64), 'axes')])
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 18)]); m.ir_version = 8; onnx.checker.check_model(m); onnx.save(m, 'onnx/vision_model_quantized.onnx')

g = helper.make_graph([helper.make_node('ReduceMax', ['input_ids', 'ax'], ['top'], keepdims=0), helper.make_node('OneHot', ['top', 'depth', 'vals'], ['text_embeds'])],
  'text', [helper.make_tensor_value_info('input_ids', TensorProto.INT64, ['b', 's'])], [helper.make_tensor_value_info('text_embeds', TensorProto.FLOAT, ['b', D])],
  [numpy_helper.from_array(np.array([1], dtype=np.int64), 'ax'), numpy_helper.from_array(np.array(D, dtype=np.int64), 'depth'), numpy_helper.from_array(np.array([0, 1], dtype=np.float32), 'vals')])
m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 18)]); m.ir_version = 8; onnx.checker.check_model(m); onnx.save(m, 'onnx/text_model_quantized.onnx')

json.dump({"model_type": "clip", "projection_dim": D, "text_config": {"model_type": "clip_text_model"}, "vision_config": {"model_type": "clip_vision_model", "image_size": 224, "patch_size": 32}}, open('config.json', 'w'))
json.dump({"crop_size": 224, "do_center_crop": True, "do_normalize": True, "do_resize": True, "image_processor_type": "CLIPImageProcessor", "image_mean": [0.48145466, 0.4578275, 0.40821073], "image_std": [0.26862954, 0.26130258, 0.27577711], "resample": 3, "size": 224}, open('preprocessor_config.json', 'w'))
special = lambda i, c: {"id": i, "content": c, "single_word": False, "lstrip": False, "rstrip": False, "normalized": False, "special": True}
json.dump({"version": "1.0", "truncation": None, "padding": None, "added_tokens": [special(0, "<unk>"), special(1, "<|endoftext|>")], "normalizer": {"type": "Lowercase"}, "pre_tokenizer": {"type": "WhitespaceSplit"}, "post_processor": None, "decoder": None, "model": {"type": "WordLevel", "vocab": vocab, "unk_token": "<unk>"}}, open('tokenizer.json', 'w'))
json.dump({"tokenizer_class": "PreTrainedTokenizer", "pad_token": "<|endoftext|>", "unk_token": "<unk>", "model_max_length": 77}, open('tokenizer_config.json', 'w'))
