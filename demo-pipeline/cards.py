#!/usr/bin/env python3
# Title cards -> PNGs in assets/
import json,os
from PIL import Image,ImageDraw,ImageFont
W,H=1244,764
F='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FB='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
def font(p,s):return ImageFont.truetype(p,s)
BG=(18,20,26);ACC=(88,166,255);FG=(232,234,240);DIM=(150,154,165)
def wrap(d,text,f,maxw):
    out=[]
    for para in text.split('\n'):
        words=para.split();line=''
        for w in words:
            t=(line+' '+w).strip()
            if d.textlength(t,font=f)<=maxw:line=t
            else:out.append(line);line=w
        out.append(line)
    return out
for i,c in enumerate(json.load(open('/home/sandbox/demo/cards.json'))):
    img=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(img)
    d.rectangle([0,0,10,H],fill=ACC)
    y=120
    kicker=c.get('kicker','')
    if kicker:
        d.text((80,y),kicker.upper(),fill=ACC,font=font(FB,20));y+=52
    for line in wrap(d,c['title'],font(FB,54),W-180):
        d.text((80,y),line,fill=FG,font=font(FB,54));y+=66
    y+=14
    for line in wrap(d,c.get('sub',''),font(F,26),W-180):
        d.text((80,y),line,fill=DIM,font=font(F,26));y+=38
    img.save(f'/home/sandbox/demo/assets/card{i:02d}.png')
    print('card%02d'%i)
