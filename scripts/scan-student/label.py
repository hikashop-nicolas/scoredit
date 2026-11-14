# Distillation set: pages at oemer's size with light rotation and scale jitter, random 288 tiles
# (mostly with ink), seg_net's soft output as labels. Writes <outdir>/x.npy (tiles) and y.npy (probabilities x 255).
# usage: python label.py <outdir> <tiles per page> <page images>...
import os, random, sys
import cv2, numpy as np, torch
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from seg_net_torch import teacher

out, K, pages = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
dev = torch.device('mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')
net = teacher().to(dev)
W = 288
rng = random.Random(7)
X, Y = [], []
for f in pages:
    im = Image.fromarray(cv2.imread(f))  # BGR bytes, as oemer feeds them
    w, h = im.size
    r = ((3000000 / (w * h) + 4350000 / (w * h)) / 2) ** 0.5 * rng.uniform(0.85, 1.15)
    im = np.array(im.resize((round(w * r), round(h * r)), Image.BICUBIC))
    h, w = im.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), rng.uniform(-1.5, 1.5), 1.0)
    im = cv2.warpAffine(im, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    ink = (im.min(2) < 128).astype(np.uint8)
    got, tries = [], 0
    while len(got) < K and tries < K * 20:
        tries += 1
        y, x = rng.randrange(0, h - W), rng.randrange(0, w - W)
        if ink[y:y + W, x:x + W].mean() < 0.01 and rng.random() > 0.1:
            continue
        got.append(im[y:y + W, x:x + W])
    if not got:
        continue
    b = np.stack(got)
    with torch.no_grad():
        p = np.concatenate([net(torch.from_numpy(b[i:i + 8]).float().to(dev)).cpu().numpy() for i in range(0, len(b), 8)])
    X.append(b)
    Y.append(np.clip(np.rint(p * 255), 0, 255).astype(np.uint8))
    print(os.path.basename(f), len(got), flush=True)
os.makedirs(out, exist_ok=True)
np.save(out + '/x.npy', np.concatenate(X))
np.save(out + '/y.npy', np.concatenate(Y))
