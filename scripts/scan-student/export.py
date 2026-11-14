# Exports a student (or oemer's seg_net itself) to a clean ONNX graph for onnxruntime-web.
# usage: python export.py <out.onnx> [--student ckpt.pt --arch s] [--batch N] [--float]
#   --batch N: free batch, height and width (wasm, tiles: "strips"); a number: fixed 288 x 288 (WebGL wants
#   --batch 1 --float, and UPCONV=1 for students, as its packed Resize has no nearest mode).
import sys, os, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, torch, onnx
from onnx import helper, numpy_helper

ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('--student'); ap.add_argument('--arch', default='')
ap.add_argument('--float', action='store_true'); ap.add_argument('--batch', default='1')
ap.add_argument('--win', type=int, default=288); ap.add_argument('--opset', type=int, default=13)
a = ap.parse_args()

if a.student:
    from student import make_student
    net = make_student(a.arch)
    net.load_state_dict(torch.load(a.student, map_location='cpu'))
else:
    from seg_net_torch import teacher
    net = teacher()
net.eval()

class Wrap(torch.nn.Module):
    def __init__(self, n, u8):
        super().__init__(); self.n = n; self.u8 = u8
    def forward(self, x):
        return self.n(x.float() if self.u8 else x)

dyn = a.batch == 'N'
b = 1 if dyn else int(a.batch)
x = torch.zeros(b, a.win, a.win, 3, dtype=torch.float32 if a.float else torch.uint8)
torch.onnx.export(Wrap(net, not a.float), x, a.out, input_names=['input'], output_names=['output'], opset_version=a.opset,
                  do_constant_folding=True, dynamic_axes={'input': {0: 'N', 1: 'H', 2: 'W'}, 'output': {0: 'N', 1: 'H', 2: 'W'}} if dyn else None)

# constant folding (pads built from shape ops) with onnxruntime's basic level, standard ops only
import onnxruntime as ort
so = ort.SessionOptions()
so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
so.optimized_model_filepath = a.out
ort.InferenceSession(a.out, so, providers=['CPUExecutionProvider'])
# fold Pad -> Conv and ConvTranspose -> Slice into the conv's own pads
m = onnx.load(a.out)
g = m.graph
init = {t.name: t for t in g.initializer}
consts = {}
for n in g.node:
    if n.op_type == 'Constant':
        consts[n.output[0]] = numpy_helper.to_array(n.attribute[0].t)
def val(name):
    if name in init: return numpy_helper.to_array(init[name])
    return consts.get(name)
users = {}
for n in g.node:
    for i in n.input: users.setdefault(i, []).append(n)
remove = []
for n in list(g.node):
    if n.op_type == 'Pad':
        pads = val(n.input[1]) if len(n.input) > 1 else None
        u = users.get(n.output[0], [])
        if pads is not None and len(u) == 1 and u[0].op_type == 'Conv' and not np.any(pads[:2]) and not np.any(pads[4:6]):
            c = u[0]
            p = [int(pads[2]), int(pads[3]), int(pads[6]), int(pads[7])]
            old = [x for x in c.attribute if x.name == 'pads']
            q = list(old[0].ints) if old else [0, 0, 0, 0]
            for x in old: c.attribute.remove(x)
            c.attribute.append(helper.make_attribute('pads', [p[0] + q[0], p[1] + q[1], p[2] + q[2], p[3] + q[3]]))
            c.input[0] = n.input[0]
            remove.append(n)
    if n.op_type == 'ConvTranspose':
        # one or two Slices keeping [0, 2h) on axes 2 and 3: crop one at the end instead
        chain, out, axes = [], n.output[0], []
        while True:
            u = users.get(out, [])
            if len(u) != 1 or u[0].op_type != 'Slice' or len(u[0].input) < 4:
                break
            s = u[0]
            st, ax = val(s.input[1]), val(s.input[3])
            if st is None or ax is None or np.any(st):
                break
            axes += ax.tolist(); chain.append(s); out = s.output[0]
        if sorted(axes) == [2, 3]:
            for x in [x for x in n.attribute if x.name == 'pads']: n.attribute.remove(x)
            n.attribute.append(helper.make_attribute('pads', [0, 0, 1, 1]))
            n.output[0] = chain[-1].output[0]
            remove += chain
for n in remove:
    g.node.remove(n)
m = onnx.shape_inference.infer_shapes(m)
onnx.checker.check_model(m)
onnx.save(m, a.out)
import collections
print(a.out, os.path.getsize(a.out), collections.Counter(n.op_type for n in m.graph.node).most_common())
