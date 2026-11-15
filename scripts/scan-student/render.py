# Renders scores with MuseScore at 150 dpi, two music fonts and staff sizes per score, at most 4 pages each.
# usage: python render.py <outdir> <score files (.mscz, .musicxml)>...   (MSCORE: the mscore binary)
# COLOR=1: through .mscx with augmentation dots red and tuplet numbers blue (color.py), for label_marks.py.
import glob, os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

out, src = sys.argv[1], sys.argv[2:]
MS = os.environ.get('MSCORE', '/Applications/MuseScore 4.app/Contents/MacOS/mscore')
styles = [('leland', 'Leland', 1.75), ('bravura', 'Bravura', 1.5), ('emmentaler', 'Emmentaler', 2.0), ('gonville', 'Gonville', 1.6), ('petaluma', 'Petaluma', 1.75)]
os.makedirs(out + '/styles', exist_ok=True)
for n, font, sp in styles:
    open(f'{out}/styles/{n}.mss', 'w').write(f'<?xml version="1.0" encoding="UTF-8"?>\n<museScore version="4.70"><Style>'
        f'<musicalSymbolFont>{font}</musicalSymbolFont><musicalTextFont>{font} Text</musicalTextFont><spatium>{sp}</spatium></Style></museScore>\n')
tasks = []
for i, s in enumerate(src):
    base = os.path.splitext(os.path.basename(s))[0]
    for n, _, _ in (styles[i % 5], styles[(i + 2) % 5]):
        tasks.append((s, f'{out}/{base}__{n}', f'{out}/styles/{n}.mss'))

def run(t):
    s, dst, st = t
    if glob.glob(dst + '-*.png'):
        return
    if os.environ.get('COLOR') == '1':
        with tempfile.TemporaryDirectory() as td:
            subprocess.run([MS, '-o', td + '/s.mscx', s], capture_output=True, timeout=600, cwd=td)
            subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'color.py'), td + '/s.mscx', td + '/c.mscx'], check=True)
            subprocess.run([MS, '-S', st, '-r', '150', '-o', dst + '.png', td + '/c.mscx'], capture_output=True, timeout=600, cwd=td)
    else:
        subprocess.run([MS, '-S', st, '-r', '150', '-o', dst + '.png', s], capture_output=True, timeout=600)
    pages = sorted(glob.glob(dst + '-*.png'))
    for p in pages[4:]:
        os.remove(p)
    print(len(pages), dst, flush=True)

with ThreadPoolExecutor(4) as ex:
    list(ex.map(run, tasks))
