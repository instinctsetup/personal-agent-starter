#!/usr/bin/env python3
# pty recorder: drives bash through a scene json, logs {t,d(b64)} jsonl.
# Waits scan only output AFTER the typed command's echo (pos cursor).
import os,pty,time,select,json,base64,sys,re
ANSI=re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-2]|\x1b[=>]')
def main(scene_path,out_path):
    sc=json.load(open(scene_path))
    pid,fd=pty.fork()
    if pid==0:
        os.environ['TERM']='xterm-256color';os.environ['COLUMNS']='120';os.environ['LINES']='30'
        os.chdir(sc['cwd']);os.execvp('bash',['bash','--noprofile','--norc'])
    rec=[];t0=time.time();buf=b'';pos=0
    def pump(dur):
        nonlocal buf
        end=time.time()+dur
        while time.time()<end:
            r,_,_=select.select([fd],[],[],0.1)
            if r:
                try:d=os.read(fd,8192)
                except OSError:break
                rec.append({'t':time.time()-t0,'d':base64.b64encode(d).decode()});buf+=d
    def clean():return ANSI.sub(b'',buf)
    def waitfor(pat,timeout):
        nonlocal pos
        end=time.time()+timeout;pb=pat.encode()
        while time.time()<end:
            c=clean();i=c.find(pb,pos)
            if i>=0:pos=i+len(pb);return True
            pump(0.25)
        print(f'WARN: timeout waiting for {pat!r} - aborting scene',flush=True)
        raise SystemExit(2)
    pump(1.0)
    os.write(fd,b'export PS1="$ "\n');pump(0.6);pos=len(clean())
    for st in sc['script']:
        if 'sleep' in st:pump(st['sleep']);continue
        if 'send' in st:
            os.write(fd,st['send'].encode()+b'\r');pump(st.get('delay',0.6))
        else:
            cmd=st.get('cmd') or st.get('shell')
            os.write(fd,cmd.encode()+b'\r')
            anchor=cmd[:40].encode()
            end=time.time()+3
            while time.time()<end:
                c=clean();i=c.find(anchor)
                if i>=0:
                    j=c.find(b'\n',i)
                    pos=(j+1) if j>=0 else len(c)
                    break
                pump(0.1)
            else: pos=len(clean())
        w=st.get('wait') or st.get('wait_only')
        if w:waitfor(w,st.get('timeout',30))
        pump(st.get('settle',1.2))
    pump(sc.get('hold',2.0))
    with open(out_path,'w') as f:
        for r in rec:f.write(json.dumps(r)+'\n')
    print(f'{os.path.basename(out_path)}: {len(rec)} chunks, {rec[-1]["t"]:.1f}s real',flush=True)
    os.close(fd)
if __name__=='__main__':main(sys.argv[1],sys.argv[2])
