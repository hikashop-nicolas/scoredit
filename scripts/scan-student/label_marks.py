# label.py for coloured renders (render.py with COLOR=1): the grey page goes to seg_net for the 4 classes,
# red pixels are augmentation dots (class 4) and blue ones tuplet numbers/brackets (class 5).
# Random 288 tiles (mostly with ink) plus tiles centred on dots and tuplets; y has 6 channels (x 255).
# usage: python label_marks.py <outdir> <random tiles per page> <focused tiles per page> <coloured page images>...
import os, random, sys
import cv2, numpy as np, torch
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from seg_net_torch import teacher

out, K, KF, pages = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:]
dev = torch.device('mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')
net = teacher().to(dev)
W = 288
rng = random.Random(7)
X, Y = [], []
for f in pages:
    c = cv2.imread(f).astype(np.int16)
    b_, g_, r_ = c[..., 0], c[..., 1], c[..., 2]
    # Antialiased colour on white: the channel that drops is the ink amount.
    dot = np.clip((r_ - g_) / 255.0, 0, 1) * ((r_ - b_) > 30)
    tup = np.clip((b_ - r_) / 255.0, 0, 1) * ((b_ - g_) > 30)
    grey = c.min(2).astype(np.uint8)
    im = np.repeat(grey[..., None], 3, 2)
    h0, w0 = grey.shape
    r = ((3000000 / (w0 * h0) + 4350000 / (w0 * h0)) / 2) ** 0.5 * rng.uniform(0.85, 1.15)
    size = (round(w0 * r), round(h0 * r))
    im = np.array(Image.fromarray(im).resize(size, Image.BICUBIC))
    m = cv2.resize(np.stack([dot, tup], 2).astype(np.float32), size, interpolation=cv2.INTER_AREA)
    h, w = im.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), rng.uniform(-1.5, 1.5), 1.0)
    im = cv2.warpAffine(im, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    m = cv2.warpAffine(m, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=(0, 0))
    lab = np.zeros((h, w), np.uint8)
    lab[m[..., 0] > 0.35] = 1
    lab[m[..., 1] > 0.35] = 2
    ink = (im.min(2) < 128).astype(np.uint8)
    got, tries = [], 0
    while len(got) < K and tries < K * 20:
        tries += 1
        y, x = rng.randrange(0, h - W), rng.randrange(0, w - W)
        if ink[y:y + W, x:x + W].mean() < 0.01 and rng.random() > 0.1:
            continue
        got.append((y, x))
    ys, xs = np.nonzero(lab)
    for _ in range(KF if len(ys) else 0):
        k = rng.randrange(len(ys))
        got.append((min(max(0, ys[k] - rng.randrange(40, W - 40)), h - W), min(max(0, xs[k] - rng.randrange(40, W - 40)), w - W)))
    if not got:
        continue
    b = np.stack([im[y:y + W, x:x + W] for y, x in got])
    L = np.stack([lab[y:y + W, x:x + W] for y, x in got])
    with torch.no_grad():
        p = np.concatenate([net(torch.from_numpy(b[i:i + 8]).float().to(dev)).cpu().numpy() for i in range(0, len(b), 8)])
    yy = np.zeros(p.shape[:3] + (6,), np.uint8)
    yy[..., :4] = np.clip(np.rint(p * 255), 0, 255)
    for k, ch in ((1, 4), (2, 5)):
        sel = L == k
        yy[sel] = 0
        yy[..., ch][sel] = 255
    X.append(b); Y.append(yy)
    print(os.path.basename(f), len(got), int((L == 1).sum()), int((L == 2).sum()), flush=True)
os.makedirs(out, exist_ok=True)
np.save(out + '/x.npy', np.concatenate(X)); np.save(out + '/y.npy', np.concatenate(Y))
