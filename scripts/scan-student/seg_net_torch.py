# oemer's Keras seg_net (arch.json + weights.h5) as a PyTorch module: NHWC BGR 0..255 in, NHWC softmax out.
# Matches oemer's seg_net ONNX file to 1e-6. Needs oemer==0.1.5 installed (its checkpoints) and h5py.
import json, os
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F

def tf_same_pad(x, k, s, d):
    # TF "same": total pad split with the extra on the bottom/right
    ke = (k - 1) * d + 1
    h, w = int(x.shape[2]), int(x.shape[3])
    ph = max((-(-h // s) - 1) * s + ke - h, 0)
    pw = max((-(-w // s) - 1) * s + ke - w, 0)
    if ph == 0 and pw == 0:
        return x
    if ph % 2 == 0 and pw % 2 == 0:
        return F.pad(x, (pw // 2, pw // 2, ph // 2, ph // 2))
    return F.pad(x, (pw // 2, pw - pw // 2, ph // 2, ph - ph // 2))

class SameConv(nn.Module):
    def __init__(self, cin, cout, k, s=1, d=1, groups=1, bias=True):
        super().__init__()
        self.k, self.s, self.d = k, s, d
        sym = s == 1 and ((k - 1) * d) % 2 == 0
        # k3 s2 on even sizes: TF's (0,1) padding equals symmetric padding after dropping row/col 0
        self.shift = s == 2 and k == 3 and d == 1
        self.conv = nn.Conv2d(cin, cout, k, s, padding=0 if self.shift else ((k - 1) * d // 2) if sym else 0, dilation=d, groups=groups, bias=bias)
        self.sym = sym
    def forward(self, x):
        if self.shift:
            # TF pads (0, 1) on even sizes; export folds this Pad into the Conv
            return self.conv(F.pad(x, (0, 1, 0, 1)))
        return self.conv(x if self.sym else tf_same_pad(x, self.k, self.s, self.d))

class SameConvT(nn.Module):
    def __init__(self, cin, cout, k, s):
        super().__init__()
        self.s, self.k = s, k
        if s == 1:
            self.conv = nn.ConvTranspose2d(cin, cout, k, 1, padding=k // 2)
        else:
            self.conv = nn.ConvTranspose2d(cin, cout, k, s, padding=0)
    def forward(self, x):
        y = self.conv(x)
        if self.s == 1:
            return y
        return y[:, :, :-1, :-1]

class LN(nn.Module):
    def __init__(self, c, eps=1e-3):
        super().__init__()
        self.ln = nn.GroupNorm(1, c, eps=eps, affine=False)
        self.weight = nn.Parameter(torch.ones(c)); self.bias = nn.Parameter(torch.zeros(c)); self.eps = eps
    def forward(self, x):
        m = x.mean(1, keepdim=True)
        v = ((x - m) ** 2).mean(1, keepdim=True)
        return (x - m) / torch.sqrt(v + self.eps) * self.weight[None, :, None, None] + self.bias[None, :, None, None]

class KerasNet(nn.Module):
    def __init__(self, arch_path, h5_path=None):
        super().__init__()
        L = json.load(open(arch_path))['config']['layers']
        self.order = []
        self.mods = nn.ModuleDict()
        ch = {}
        for l in L:
            cn, name, c = l['class_name'], l['name'], l['config']
            ins = [x[0] for x in l['inbound_nodes'][0]] if l['inbound_nodes'] else []
            self.order.append((cn, name, ins, c))
            if cn == 'InputLayer':
                ch[name] = 3
            elif cn in ('Conv2D', 'SeparableConv2D'):
                k, s, d = c['kernel_size'][0], c['strides'][0], c['dilation_rate'][0]
                cin = ch[ins[0]]
                if cn == 'Conv2D':
                    self.mods[name] = SameConv(cin, c['filters'], k, s, d)
                else:
                    self.mods[name] = nn.Sequential(SameConv(cin, cin, k, s, d, groups=cin, bias=False), nn.Conv2d(cin, c['filters'], 1))
                ch[name] = c['filters']
            elif cn == 'Conv2DTranspose':
                self.mods[name] = SameConvT(ch[ins[0]], c['filters'], c['kernel_size'][0], c['strides'][0])
                ch[name] = c['filters']
            elif cn == 'LayerNormalization':
                self.mods[name] = LN(ch[ins[0]], c['epsilon'])
                ch[name] = ch[ins[0]]
            elif cn == 'Concatenate':
                ch[name] = sum(ch[i] for i in ins)
            else:
                ch[name] = ch[ins[0]]
        self.out_name = L[-1]['name']
        if h5_path:
            self.load_h5(h5_path)

    def load_h5(self, path):
        import h5py
        f = h5py.File(path, 'r')
        for cn, name, ins, c in self.order:
            if name not in self.mods:
                continue
            g = f[name][name]
            m = self.mods[name]
            T = lambda a: torch.from_numpy(np.array(a))
            if cn == 'Conv2D':
                m.conv.weight.data = T(g['kernel:0']).permute(3, 2, 0, 1).contiguous(); m.conv.bias.data = T(g['bias:0'])
            elif cn == 'SeparableConv2D':
                dw = T(g['depthwise_kernel:0'])  # k,k,in,1
                m[0].conv.weight.data = dw.permute(2, 3, 0, 1).contiguous()
                m[1].weight.data = T(g['pointwise_kernel:0']).permute(3, 2, 0, 1).contiguous(); m[1].bias.data = T(g['bias:0'])
            elif cn == 'Conv2DTranspose':
                # keras kernel k,k,out,in ; torch in,out,k,k ; transposed conv in TF is the gradient of conv: no flip needed
                m.conv.weight.data = T(g['kernel:0']).permute(3, 2, 0, 1).contiguous(); m.conv.bias.data = T(g['bias:0'])
            elif cn == 'LayerNormalization':
                m.weight.data = T(g['gamma:0']); m.bias.data = T(g['beta:0'])

    def forward(self, x, logits=False):
        # x: N,H,W,3 float (0..255, BGR as oemer feeds it)
        t = {}
        for cn, name, ins, c in self.order:
            if cn == 'InputLayer':
                v = x.permute(0, 3, 1, 2)
            elif name in self.mods:
                v = self.mods[name](t[ins[0]])
            elif cn == 'Activation':
                v = t[ins[0]]
                if c['activation'] == 'relu':
                    v = F.relu(v)
            elif cn == 'Dropout':
                v = t[ins[0]]
            elif cn == 'Add':
                v = t[ins[0]]
                for i in ins[1:]:
                    v = v + t[i]
            elif cn == 'Concatenate':
                v = torch.cat([t[i] for i in ins], 1)
            else:
                raise ValueError(cn)
            act = c.get('activation')
            if cn in ('Conv2D', 'SeparableConv2D', 'Conv2DTranspose') and act and act != 'linear':
                if act == 'relu':
                    v = F.relu(v)
                elif act == 'softmax' and name != self.out_name:
                    v = F.softmax(v, 1)
            t[name] = v
        out = t[self.out_name]
        if logits:
            return out
        return F.softmax(out, 1).permute(0, 2, 3, 1)


def teacher():
    """oemer's seg_net with its trained weights."""
    import oemer
    d = os.path.join(os.path.dirname(oemer.__file__), 'checkpoints', 'seg_net')
    return KerasNet(os.path.join(d, 'arch.json'), os.path.join(d, 'weights.h5')).eval()
