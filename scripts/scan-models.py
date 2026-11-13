#!/usr/bin/env python3
# Prepares oemer's models for readScanScore: its symbols network (seg_net), its four SVM
# classifiers as one JSON file, and optionally an int8 copy of the symbols network (a
# quarter of the size). Both were trained on DeepScoresV2 (CC BY 4.0). --staff also copies
# the staff network (unet_big, trained on CVC-MUSCIMA, CC BY-NC-SA 4.0: comparison only).
#   pip install oemer==0.1.5 onnx onnxruntime   (oemer downloads its checkpoints on first run)
#   python scripts/scan-models.py out/ [--int8 calibration.png] [--staff]
# Run with numpy < 1.24, or the np.int aliases below cover newer versions.
import base64
import json
import os
import pickle
import sys

import numpy as np

for alias, t in (("int", int), ("float", float), ("bool", bool)):
    if not hasattr(np, alias):
        setattr(np, alias, t)

from oemer import MODULE_PATH  # noqa: E402

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

# SVC models: support vectors are 40x70 grey images (0..255), exported as bytes.
svms = {}
for name in ("clef", "rests", "rests_above8", "sfn"):
    info = pickle.load(open(os.path.join(MODULE_PATH, "sklearn_models", name + ".model"), "rb"))
    m = info["model"]
    sv = m.support_vectors_
    assert m.kernel == "rbf" and np.all(sv == np.round(sv)) and sv.min() >= 0 and sv.max() <= 255
    svms[name] = {
        "w": info["w"],
        "h": info["h"],
        "classes": [info["class_map"][int(c)] for c in m.classes_],
        "gamma": float(m._gamma),
        "nSV": [int(v) for v in m._n_support],
        "rho": (-np.asarray(m._intercept_, dtype=np.float64)).tolist(),
        "coef": base64.b64encode(np.asarray(m._dual_coef_, dtype="<f8").tobytes()).decode(),
        "sv": base64.b64encode(sv.astype(np.uint8).tobytes()).decode(),
    }
json.dump(svms, open(os.path.join(out, "oemer-classifiers.json"), "w"))

nets = {"unet_big": ("oemer-staff", 256), "seg_net": ("oemer-symbols", 288)}
for src, (dst, _) in nets.items():
    if src == "unet_big" and "--staff" not in sys.argv:
        continue
    with open(os.path.join(MODULE_PATH, "checkpoints", src, "model.onnx"), "rb") as f, open(os.path.join(out, dst + ".onnx"), "wb") as g:
        g.write(f.read())

if "--int8" in sys.argv:
    # Static QDQ quantisation, calibrated on tiles of a printed page.
    import onnx
    from onnx import version_converter
    from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
    from PIL import Image

    page = np.array(Image.open(sys.argv[sys.argv.index("--int8") + 1]).convert("RGB"))[..., ::-1]
    for src, (dst, win) in [("seg_net", nets["seg_net"])]:
        # Per-channel QDQ needs opset 13; onnxruntime's offline-optimised graph does not load in onnxruntime-web.
        tmp = os.path.join(out, dst + ".tmp.onnx")
        onnx.save(version_converter.convert_version(onnx.load(os.path.join(out, dst + ".onnx")), 13), tmp)

        class Tiles(CalibrationDataReader):
            def __init__(self):
                rng = np.random.default_rng(1)
                h, w = page.shape[:2]
                self.it = iter(
                    {"input": np.ascontiguousarray(page[None, y : y + win, x : x + win])}
                    for y, x in ((int(rng.integers(0, h - win)), int(rng.integers(0, w - win))) for _ in range(32))
                )

            def get_next(self):
                return next(self.it, None)

        quantize_static(tmp, os.path.join(out, dst + ".int8.onnx"), Tiles(), quant_format=QuantFormat.QDQ,
                        per_channel=True, activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8)
        os.remove(tmp)

for f in sorted(os.listdir(out)):
    print(f, os.path.getsize(os.path.join(out, f)))
