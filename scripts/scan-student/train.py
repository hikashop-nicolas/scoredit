# Distils seg_net into a student with scan-like augmentation (done on CPU workers), on MPS, CUDA or CPU.
# usage: python train.py <arch> <out.pt> <minutes> --data <dir from label.py> --val <dir from label.py> [--init ckpt]
import sys, os, time, math, argparse, copy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, cv2, torch, torch.nn.functional as F
from student import make_student

def warp_pair(x, y, rng):
    # same random affine + mild perspective on image (white border) and soft labels (background border)
    h, w = x.shape[:2]
    ang = rng.uniform(-2.5, 2.5); sc = rng.uniform(0.88, 1.12); sh = rng.uniform(-0.04, 0.04)
    M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, sc)
    M[0, 1] += sh
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = cv2.transform(src[None], M)[0]
    dst += rng.uniform(-6, 6, dst.shape).astype(np.float32)
    P = cv2.getPerspectiveTransform(src, dst.astype(np.float32))
    xw = cv2.warpPerspective(x, P, (w, h), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    yw = cv2.warpPerspective(y, P, (w, h), flags=cv2.INTER_LINEAR, borderValue=(255, 0, 0, 0))
    return xw, yw

def degrade(x, other, rng):
    # scan look on a BGR uint8 tile; `other` gives bleed-through
    a = x.astype(np.float32)
    if rng.random() < 0.7:
        a = np.repeat(a.mean(2, keepdims=True), 3, 2)
    h, w = a.shape[:2]
    if rng.random() < 0.5:  # resolution loss
        f = rng.uniform(0.55, 0.9)
        a = cv2.resize(cv2.resize(a, (int(w * f), int(h * f)), interpolation=cv2.INTER_AREA), (w, h), interpolation=cv2.INTER_LINEAR)
    if rng.random() < 0.3:  # bleed-through from the other side
        b = cv2.flip(other.astype(np.float32).mean(2), 1)
        b = cv2.GaussianBlur(b, (0, 0), rng.uniform(0.8, 2.5))
        a -= (255 - b)[..., None] * rng.uniform(0.04, 0.18)
    ink = rng.uniform(0.6, 1.0); paper = rng.uniform(0.7, 1.0)
    a = (255 - (255 - a) * ink) * paper
    if rng.random() < 0.3:
        a *= np.array([rng.uniform(0.9, 1.0), rng.uniform(0.93, 1.0), 1.0], np.float32)  # yellowish paper
    if rng.random() < 0.6:  # uneven lighting
        g = cv2.resize(rng.uniform(0.75, 1.08, (3, 3)).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
        a *= g[..., None]
    if rng.random() < 0.7:
        a = cv2.GaussianBlur(a, (0, 0), rng.uniform(0.4, 1.6))
    if rng.random() < 0.7:
        a += rng.normal(0, rng.uniform(2, 22), a.shape if rng.random() < 0.3 else (h, w, 1)).astype(np.float32)
    if rng.random() < 0.15:  # salt and pepper / speckle
        m = rng.random((h, w)) < rng.uniform(0.001, 0.01)
        a[m] = rng.choice([0, 255])
    a = np.clip(a, 0, 255)
    if rng.random() < 0.12:  # thresholded scan
        t = rng.uniform(100, 190)
        a = np.where(a.mean(2, keepdims=True) < t, rng.uniform(0, 60), rng.uniform(200, 255)).repeat(3, 2)
    if rng.random() < 0.3:
        gam = math.exp(rng.uniform(-0.4, 0.4)); a = 255 * (a / 255) ** gam
    a = np.clip(a, 0, 255).astype(np.uint8)
    if rng.random() < 0.5:
        ok, enc = cv2.imencode('.jpg', a, [cv2.IMWRITE_JPEG_QUALITY, int(rng.integers(25, 92))])
        a = cv2.imdecode(enc, cv2.IMREAD_COLOR)
    return a

class DS(torch.utils.data.Dataset):
    def __init__(self, d, crop, n):
        self.d, self.crop, self.n = d, crop, n
        self.X = self.Y = None
    def __len__(self):
        return self.n
    def __getitem__(self, i):
        if self.X is None:
            self.X = np.load(self.d + '/x.npy', mmap_mode='r'); self.Y = np.load(self.d + '/y.npy', mmap_mode='r')
        rng = np.random.default_rng((os.getpid() * 1000003 + i * 7919 + int(time.time() * 1000)) % 2**32)
        k = int(rng.integers(0, len(self.X)))
        x, y = np.array(self.X[k]), np.array(self.Y[k])
        if rng.random() < 0.8:
            x, y = warp_pair(x, y, rng)
        c = self.crop
        oy, ox = rng.integers(0, 288 - c + 1, 2)
        x, y = x[oy:oy + c, ox:ox + c], y[oy:oy + c, ox:ox + c]
        if rng.random() < 0.85:
            x = degrade(x, np.array(self.X[int(rng.integers(0, len(self.X)))])[:c, :c], rng)
        return torch.from_numpy(np.ascontiguousarray(x)), torch.from_numpy(np.ascontiguousarray(y))

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('arch'); ap.add_argument('out'); ap.add_argument('minutes', type=float)
    ap.add_argument('--data'); ap.add_argument('--val'); ap.add_argument('--crop', type=int, default=192)
    ap.add_argument('--bs', type=int, default=16); ap.add_argument('--lr', type=float, default=2e-3)
    ap.add_argument('--workers', type=int, default=5); ap.add_argument('--init')
    a = ap.parse_args()
    torch.set_num_threads(2)
    dev = torch.device('mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu')
    VX = np.load(a.val + '/x.npy', mmap_mode='r'); VY = np.load(a.val + '/y.npy', mmap_mode='r')
    net = make_student(a.arch).to(dev)
    if a.init:
        net.load_state_dict(torch.load(a.init, map_location='cpu'))
    ema = copy.deepcopy(net).eval()
    opt = torch.optim.AdamW(net.parameters(), a.lr, weight_decay=1e-4)
    dl = torch.utils.data.DataLoader(DS(a.data, a.crop, 10**8), batch_size=a.bs, num_workers=a.workers, persistent_workers=True, prefetch_factor=4)

    def evaluate(m):
        agree, inter, union = 0, np.zeros(4), np.zeros(4)
        with torch.no_grad():
            for i in range(0, len(VX), 16):
                p = m(torch.from_numpy(np.array(VX[i:i + 16])).to(dev).float()).argmax(-1).cpu().numpy()
                t = np.array(VY[i:i + 16]).argmax(-1)
                agree += (p == t).sum()
                for k in range(4):
                    inter[k] += ((p == k) & (t == k)).sum(); union[k] += ((p == k) | (t == k)).sum()
        return agree / VY[..., 0].size, inter / np.maximum(union, 1)

    t0 = time.time(); budget = a.minutes * 60; step = 0; tl = 0; best = -1; last = t0
    for x, y in dl:
        frac = (time.time() - t0) / budget
        if frac >= 1:
            break
        lr = a.lr * (min(1, step / 300) * 0.5 * (1 + math.cos(math.pi * frac)))
        for g in opt.param_groups: g['lr'] = lr
        x = x.to(dev).float(); y = y.to(dev).float() / 255
        logp = F.log_softmax(net(x, logits=True), 1).permute(0, 2, 3, 1)
        w = 1 + 4 * (1 - y[..., 0])
        loss = -((y * logp).sum(-1) * w).mean()
        opt.zero_grad(); loss.backward(); opt.step(); step += 1; tl += loss.item()
        with torch.no_grad():
            dcy = min(0.999, (1 + step) / (10 + step))
            for pe, pn in zip(ema.parameters(), net.parameters()): pe.mul_(dcy).add_(pn.detach(), alpha=1 - dcy)
            for be, bn in zip(ema.buffers(), net.buffers()): be.copy_(bn)
        if time.time() - last > 600 or step == 50:
            ag, iou = evaluate(ema)
            print(f'step {step} min {(time.time() - t0) / 60:.1f} lr {lr:.5f} loss {tl / max(1, step):.4f} ema val agree {ag:.4f} iou ' + ' '.join(f'{v:.3f}' for v in iou[1:]), flush=True)
            last = time.time()
            if iou[1:].mean() > best:
                best = iou[1:].mean(); torch.save(ema.state_dict(), a.out)
    ag, iou = evaluate(ema)
    print(f'final step {step} ema val agree {ag:.4f} iou ' + ' '.join(f'{v:.3f}' for v in iou[1:]), flush=True)
    torch.save(ema.state_dict(), a.out)
    os._exit(0)
