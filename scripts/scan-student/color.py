# color.py in.mscx out.mscx: augmentation dots red, tuplet numbers/brackets blue.
import re, sys
s = open(sys.argv[1], encoding='utf-8').read()
RED = '<color r="255" g="0" b="0" a="255"/>'
BLUE = '<color r="0" g="0" b="255" a="255"/>'
def chord(m):
    body = m.group(0)
    d = re.search(r'<dots>(\d+)</dots>', body)
    if not d:
        return body
    n = int(d.group(1))
    dots = ''.join(f'<NoteDot>{RED}</NoteDot>' for _ in range(n))
    if body.startswith('<Chord'):
        return re.sub(r'</Note>', dots + '</Note>', body)
    return body.replace('</Rest>', dots + '</Rest>')
s = re.sub(r'<Chord>.*?</Chord>', chord, s, flags=re.S)
s = re.sub(r'<Rest>.*?</Rest>', chord, s, flags=re.S)
s = re.sub(r'(<Tuplet>)', r'\1' + BLUE, s)
s = re.sub(r'(<Number>)', r'\1' + BLUE, s)
open(sys.argv[2], 'w', encoding='utf-8').write(s)
