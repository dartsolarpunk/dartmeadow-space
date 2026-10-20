# Generates the interior textures in the style of the reference bridge video:
# cyan holographic charts on deep teal, rainbow keycap decks, dark ceiling mesh.
import math, random
from PIL import Image, ImageDraw, ImageFont
random.seed(11)
OUT='tex/'
FB='/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
def font(n): return ImageFont.truetype(FB,n)
CY=(120,255,245); CY2=(60,200,210); BG=(4,26,34); GRID=(14,66,76)
def holo_base(w,h,title):
    im=Image.new('RGB',(w,h),BG); d=ImageDraw.Draw(im)
    for x in range(0,w,w//16): d.line([(x,0),(x,h)],fill=GRID)
    for y in range(0,h,h//10): d.line([(0,y),(w,y)],fill=GRID)
    d.rectangle([3,3,w-4,h-4],outline=CY2,width=3)
    d.rectangle([3,3,w-4,34],fill=(8,60,70)); d.text((14,6),title,font=font(22),fill=CY)
    return im,d
def holo_chart(name,seed,kind):
    random.seed(seed); w,h=1024,640
    im,d=holo_base(w,h,name.upper())
    if kind=='wave':
        pts=[];y=h*0.45
        for x in range(30,w-30,6):
            y+=random.uniform(-26,24); y=min(max(y,h*0.18),h*0.62); pts.append((x,y))
        d.polygon([(30,h*0.68)]+pts+[(w-30,h*0.68)],fill=(40,170,180))
        d.line(pts,fill=CY,width=4)
    else:
        x=40
        while x<w-60:
            bh=random.uniform(40,h*0.5); d.rectangle([x,h*0.68-bh,x+14,h*0.68],fill=CY); x+=20
    for i in range(4):
        yy=int(h*0.74+i*34); d.rectangle([40,yy,w-40,yy+16],outline=CY2,width=2)
        d.rectangle([44,yy+3,44+int((w-90)*random.uniform(.2,.95)),yy+13],fill=CY)
    im.save(OUT+f'holo_{name}.png')
def holo_radar(name,seed):
    random.seed(seed); w,h=1024,640
    im,d=holo_base(w,h,name.upper())
    cx,cy,r=300,340,230
    for k in (1,.66,.33): d.ellipse([cx-r*k,cy-r*k,cx+r*k,cy+r*k],outline=CY2,width=3)
    d.line([(cx-r,cy),(cx+r,cy)],fill=CY2,width=2); d.line([(cx,cy-r),(cx,cy+r)],fill=CY2,width=2)
    d.pieslice([cx-r,cy-r,cx+r,cy+r],-70,-20,fill=(40,170,180))
    for _ in range(9):
        a=random.uniform(0,6.28); rr=random.uniform(30,r-20); px,py=cx+rr*math.cos(a),cy+rr*math.sin(a); d.ellipse([px-6,py-6,px+6,py+6],fill=(255,210,80))
    for i in range(9):
        yy=90+i*52; d.rectangle([600,yy,980,yy+34],outline=CY2,width=2)
        d.rectangle([606,yy+6,606+int(360*random.uniform(.1,.95)),yy+28],fill=CY if i%3 else (255,120,120))
    im.save(OUT+f'holo_{name}.png')
def holo_text(name,lines,w=1024,h=640,title=None):
    im,d=holo_base(w,h,title or name.upper())
    y=70
    for ln in lines:
        d.text((40,y),ln,font=font(34),fill=CY); y+=54
    im.save(OUT+f'holo_{name}.png')
def keys(name,w=1024,h=512):
    random.seed(5)
    im=Image.new('RGB',(w,h),(60,40,110)); d=ImageDraw.Draw(im)
    pal=[(120,90,200),(90,70,170),(70,200,220),(250,210,60),(240,90,70),(90,230,170),(230,120,220)]
    rows=6; cols=22; m=26
    kw=(w-2*m)/cols; kh=(h*0.62-m)/rows
    for r in range(rows):
        for c in range(cols):
            col=pal[0] if random.random()<.55 else random.choice(pal[1:])
            if r>=4 and 5<c<16: col=pal[0]
            x=m+c*kw; y=m+r*kh
            d.rounded_rectangle([x+2,y+2,x+kw-2,y+kh-2],radius=4,fill=col)
    # button clusters
    for i in range(4):
        for j in range(3):
            x=w-230+i*50; y=h*0.68+j*46
            d.rounded_rectangle([x,y,x+38,y+34],radius=6,fill=random.choice(pal[2:]))
    for i in range(10):
        d.rounded_rectangle([m+i*44,h*0.7,m+i*44+34,h*0.7+26],radius=5,fill=random.choice(pal[2:5]))
    im.save(OUT+f'{name}.png')
def grille():
    w=h=256; im=Image.new('RGB',(w,h),(8,10,16)); d=ImageDraw.Draw(im)
    for x in range(0,w,16):
        d.line([(x,0),(x,h)],fill=(22,30,44),width=3)
        d.line([(0,x),(w,x)],fill=(22,30,44),width=3)
    im.save(OUT+'grille.png')
def deckplate():
    w=h=256; im=Image.new('RGB',(w,h),(20,16,36)); d=ImageDraw.Draw(im)
    for x in range(0,w,64):
        d.line([(x,0),(x,h)],fill=(46,38,80),width=2); d.line([(0,x),(w,x)],fill=(46,38,80),width=2)
    for _ in range(40):
        x=random.randrange(w); y=random.randrange(h); d.point((x,y),fill=(60,50,100))
    im.save(OUT+'deckplate.png')
def sign(name,top,bot,col=(120,255,245)):
    w,h=1024,320; im=Image.new('RGB',(w,h),(6,20,30)); d=ImageDraw.Draw(im)
    d.rectangle([4,4,w-5,h-5],outline=col,width=5)
    d.text((40,40),top,font=font(120),fill=col); d.text((44,200),bot,font=font(54),fill=(180,170,255))
    im.save(OUT+f'sign_{name}.png')
holo_chart('nav_a',1,'wave'); holo_chart('nav_b',2,'bars'); holo_chart('nav_c',3,'wave'); holo_chart('nav_d',4,'bars')
holo_radar('radar',7); holo_radar('sector',8)
holo_text('menu',['TODAY: MESS DECK','','> NOODLE BOWL','> ROOT STEW','> BREAD + HONEY','> TEA / WATER','','CREW 24 / SEATS 32'],title='GALLEY')
holo_text('engine',['CORE   STABLE','OUTPUT 100%','TEMP   NOMINAL','FLUX   0.82','','RING A  ON','RING B  ON'],title='ENGINEERING')
holo_text('crew',['QUARTERS','','BUNK 1-12','LOCKERS  OK','LIGHTS  DIM'],title='CREW DECK')
keys('keys'); grille(); deckplate()
sign('A','DECK A','NAVIGATION'); sign('B','DECK B','MESS HALL'); sign('C','DECK C','CREW / ENGINE'); sign('TOP','HATCH','TO LOWER DECKS'); sign('STORE','FOOD STORE','COLD + DRY STORES'); sign('ENG','ENGINEERING','REACTOR')
print('ok')
