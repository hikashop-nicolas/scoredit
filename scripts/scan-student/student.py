# Small U-Nets distilled from seg_net: 3x3 convs + BatchNorm (folded at export), NHWC BGR 0..255 in, NHWC softmax out.
import os, torch, torch.nn as nn, torch.nn.functional as F
UPCONV = os.environ.get('UPCONV') == '1'

def cbr(cin, cout, s=1, d=1):
    return nn.Sequential(nn.Conv2d(cin, cout, 3, s, padding=d, dilation=d, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))

class Res(nn.Module):
    def __init__(self, c, d=1):
        super().__init__()
        self.a = cbr(c, c, 1, d)
        self.b = nn.Sequential(nn.Conv2d(c, c, 3, 1, padding=d, dilation=d, bias=False), nn.BatchNorm2d(c))
    def forward(self, x):
        return F.relu(x + self.b(self.a(x)))

class Student(nn.Module):
    # w: widths at 1/1, 1/2, 1/4, 1/8, 1/16
    def __init__(self, w=(8, 16, 32, 64, 96), nres=(0, 1, 2, 2, 3), classes=4):
        super().__init__()
        self.stem = cbr(3, w[0])
        self.down = nn.ModuleList([cbr(w[i], w[i + 1], 2) for i in range(4)])
        self.enc = nn.ModuleList([nn.Sequential(*[Res(w[i], d=(2 ** k if i == 4 else 1)) for k in range(nres[i])]) for i in range(5)])
        self.up = nn.ModuleList([cbr(w[i + 1] + w[i], w[i]) for i in range(4)])
        self.head = nn.Conv2d(w[0], classes, 1)
    def forward(self, x, logits=False):
        x = x.permute(0, 3, 1, 2) * (1 / 255.0)
        skips = []
        x = self.enc[0](self.stem(x))
        for i in range(4):
            skips.append(x)
            x = self.enc[i + 1](self.down[i](x))
        for i in reversed(range(4)):
            if UPCONV:
                # nearest 2x as a fixed depthwise transposed conv (WebGL has no packed nearest Resize)
                c = x.shape[1]
                x = F.conv_transpose2d(x, x.new_ones(c, 1, 2, 2), stride=2, groups=c)
            else:
                x = F.interpolate(x, scale_factor=2, mode='nearest')
            x = self.up[i](torch.cat([x, skips[i]], 1))
        y = self.head(x)
        return y if logits else F.softmax(y, 1).permute(0, 2, 3, 1)

ARCHS = {
    'xs': dict(w=(8, 16, 32, 64, 96), nres=(0, 1, 2, 2, 3)),
    's': dict(w=(12, 24, 48, 96, 128), nres=(0, 1, 2, 2, 3)),
    'm': dict(w=(16, 32, 64, 128, 192), nres=(0, 1, 2, 3, 3)),
}

def make_student(arch):
    return Student(**ARCHS[arch or 's'])

if __name__ == '__main__':
    import sys
    for k in ARCHS:
        n = make_student(k)
        p = sum(t.numel() for t in n.parameters())
        mac = 0
        def hook(m, i, o):
            global mac
            mac += o.numel() * m.in_channels // m.groups * m.kernel_size[0] * m.kernel_size[1]
        for m in n.modules():
            if isinstance(m, nn.Conv2d): m.register_forward_hook(hook)
        n.eval()(torch.zeros(1, 288, 288, 3))
        print(k, 'params %.2fM' % (p / 1e6), 'GMAC/tile %.2f' % (mac / 1e9))
