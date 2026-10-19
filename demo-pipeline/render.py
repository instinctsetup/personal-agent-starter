#!/usr/bin/env python3
# jsonl -> PNG frames (pyte) + ffmpeg concat list
import json,base64,sys,os,pyte
from PIL import Image,ImageDraw,ImageFont
COLS,ROWS=120,30;CW,CH=10,19;W,H=COLS*CW+44,ROWS*CH+44
FONT='/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
def font(sz):return ImageFont.truetype(FONT,sz)
BG=(24,26,32);FG=(210,212,218);BAR=(40,42,50)
def draw(lines,title):
    img=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(img)
    d.rectangle([0,0,W,34],fill=BAR)
    d.ellipse([12,10,24,22],fill=(255,95,86));d.ellipse([28,10,40,22],fill=(255,189,46));d.ellipse([44,10,56,22],fill=(39,201,63))
    tw=d.textlength(title,font=font(14))
    d.text(((W-tw)/2,9),title,fill=(150,152,160),font=font(14))
    f=font(15)
    for y,line in enumerate(lines):
        d.text((22,40+y*CH),line,fill=FG,font=f)
    return img
def main(jsonl,outdir,listfile,title,max_gap=1.2,tail_hold=3.0):
    events=[json.loads(l) for l in open(jsonl)]
    scr=pyte.Screen(COLS,ROWS);stream=pyte.Stream(scr)
    os.makedirs(outdir,exist_ok=True)
    seq=[];last_t=0.0
    for ev in events:
        dt=ev['t']-last_t;last_t=ev['t']
        data=base64.b64decode(ev['d']).decode('utf-8',errors='replace')
        stream.feed(data)
        seq.append((max(0.05,min(dt,max_gap)),scr.display.copy()))
    if not seq:print('empty');return
    seq[-1]=(seq[-1][0]+tail_hold,seq[-1][1])
    n=0
    with open(listfile,'w') as lf:
        for hold,lines in seq:
            p=os.path.abspath(f'{outdir}/f{n:05d}.png');n+=1
            draw(lines,title).save(p)
            lf.write(f"file '{p}'\nduration {hold:.2f}\n")
        lf.write(f"file '{p}'\n")
    print(f'{os.path.basename(jsonl)}: {n} frames')
if __name__=='__main__':main(sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4])
